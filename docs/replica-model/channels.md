# Channels, continuity and operation evidence

Status: **draft, phase 1**. This document owns channel identity, invitation
consumption, directed continuity evidence and operation eligibility. Storage
envelopes and durability follow [event-store.md](event-store.md). Sending and
effect ordering follow [distributed-delivery.md](distributed-delivery.md).
The capitalized requirement words have their BCP 14 meanings.

<a id="model"></a>

## 1. Model

A **channel** is the fixed ordered pair `(localDid, peerDid)` of distinct
canonical `did:peer:4` communication DIDs, viewed from one vault. Each
message retains its sender, recipient, authenticated keys and exact immutable
document evidence. Mutable channel DIDs belong to a
[deferred extension](did-web-channels.md); mediator DIDs follow a separate
[resolution policy](relationships.md#mediator-resolution).

A **continuity link** is a derived replacement of exactly one endpoint in the
context of one channel. The fold computes it from received proofs, resolution
evidence and local rotation decisions; no link event is stored.
Links form a directed graph whose authority is scoped to each channel context.

A **contact** organizes selected channels with local names and preferences.
Creation selects complete local/peer DID pairs and may precede receipt or peer
resolution. Contact edits affect presentation and preferences, not message
identity or protocol authority. Channels and continuity exist independently of
contacts; unassigned channels remain usable.

```mermaid
flowchart TD
    A[Authenticate actual sender and recipient] --> B[Save channel receipt]
    B --> C[Pickup ACK]
    B --> D[Validate source and continuity evidence]
    D --> E[Check the specific operation and current policy]
    E --> F[Commit its concrete intent or observed result]
    B --> G[Channel and contact views]
    D --> G
```

Receipt needs no invitation consumption, contact or continuity history.
Anonymous input has no channel or application execution. Each later operation
checks its own evidence and policy under section 6.

<a id="channel-identity"></a>

## 2. Channel identity

Validate and canonicalize both DIDs under
[the DID profile](relationships.md#peer-did-numalgo-4-profile). A channel value
has exactly these two DID strings:

```ts
type Channel = { localDid: Did; peerDid: Did };
```

Both endpoints use the canonical numalgo-4 short form. Compare each role
byte-for-byte; equal endpoints are invalid. `(A, B)` and `(B, A)` are different
vault-local views.
Receiving from B at A and sending from A to B use the same `(A, B)` channel.
The notation `C(A, B)` throughout this profile means `{localDid: A, peerDid: B}`.

Receipts derive the pair from the local key's DID and authenticated sender.
Outbound intents derive it from `senderDidId` and canonical `recipientDid`.
Source-based facts use the pair of their referenced message. Missing exact
endpoint evidence leaves that projection pending; contact membership, another
observation or a shared key cannot supply it.

Selectors such as contact membership and blocking store the two canonical DID
strings directly. Canonicalize supplied long forms before storing a selector.
Its syntax and distinctness can be checked offline; missing DID documents or
local entities leave evidence unresolved and grant no authority.
Compare selectors by both roles. Sort sets by unsigned UTF-8 byte order of
`RFC8785([localDid, peerDid])`, with no duplicate pairs. This ordering sorts the
set, not the two endpoints within a pair.

Replacing either DID creates another channel; document CIDs, keys and resolution
event IDs are verification evidence. Changing a numalgo-4 encoded document
yields another DID. Shared keys or services never alias distinct DIDs.

<a id="receipt"></a>

## 3. Durable receipt

Perform exact recipient, route, cryptographic, syntax, resource and current
sender checks under [the receive gate](relationships.md#hard-pre-vault-gate).
Do not consult contact membership or continuity membership. Retired local keys
may drain an otherwise eligible retained route; retirement still blocks new
sending, disclosure and new invitation consumption.

Under the operation lock, recheck local prerequisites, commit/reuse the exact
resolution document, then commit `message.in` with objects and receipt ordinal.
Derive the channel from the actual local recipient and authenticated sender;
anonymous input has no peer or channel. Preserve the original `fromPrior`, local key,
resolution reference, hashes and source as immutable observations.

Normal pickup ACK follows process-durable receipt. An unknown, blocked,
superseded or incomplete channel can still retain an authenticated observation.
Receipt grants no peer ACK, protocol effect or invitation consumption.
Hard cryptographic/wrong-recipient/resource rejection keeps the terminal
pre-vault ACK path. Failure to durably save an otherwise receivable input
withholds pickup ACK.

<a id="carried-proof-and-library-boundary"></a>

### 3.1 Carried proof and library boundary

Present-sender authentication and permission to inherit a predecessor's
channel authority are distinct checks. A phase-1 DIDComm adapter MUST support
authenticated unpack independently of `from_prior` verification. It MUST return
the original string-valued `from_prior` unchanged and distinguish an unverified
claim from verified proof metadata. Missing predecessor material, a malformed
JWT or an invalid proof MUST NOT prevent otherwise valid authenticated receipt
and its pickup ACK. A non-string header still fails ordinary wire syntax checks.

The adapter MUST retain all envelope integrity, current-sender authorization,
recipient and cross-layer addressing checks. Failure of those checks follows
the hard pre-vault gate; no failed authentication may be presented as success.
Predecessor resolution and proof verification occur after receipt under
[the proof rule](relationships.md#predecessor-resolution). Use maintained
DIDComm/JOSE verification and encoding APIs against the exact predecessor
document. Never strip the proof or treat decoding as verification. A library
that couples proof verification to unpack needs an explicit deferred-proof
mode; waiting unopened for continuity is not a phase-1 fallback.

Save the message in its actual authenticated sender/recipient channel while
continuity is pending or invalid. Invalid proof authorizes no operation based
on that proof. Per-source ingress limits use the authenticated sender, never
the unverified `from_prior.iss`.
This uses the rotation primitive in
[DIDComm Messaging 2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation).
The channel graph and local policy below are this application's design.

<a id="verification-status"></a>

### 3.2 Verification status and display

Receipt and continuity verification are separate visible facts. A saved
authenticated message MAY be displayed before continuity completes, with an
explicit status beside the message. Do not present a pending sender as the
verified continuation of an earlier peer or silently group it on that basis.
The UI MUST distinguish these derived states:

| State | Meaning |
| --- | --- |
| `not-present` | No `from_prior`; ordinary channel policy still applies |
| `pending-proof` | A proof is present but its required verification document/evidence is unavailable |
| `pending-history` | The proof verifies, but an exact source, endpoint or rotation record needed for the queried continuity path is missing |
| `verified` | Both proof and channel context validate; the link is derivable |
| `invalid` | The carried claims or complete verification evidence fail validation |
| `conflict` | Complete evidence establishes competing successors or contradictory channel authority |

Rebuild these states from retained evidence. Missing imported references remain
pending, not invalid. Missing local issuer material may add a bounded
diagnostic; its absence is not proof of a bad signature. Channel denial and
invitation/operation status are shown separately. Invitation availability
does not make continuity pending. If an imported receipt's
own sender evidence is missing, show that pending authentication separately;
do not claim its sender has already been verified. Pending/invalid/conflicted
continuity grants no peer ACK, handler effect or inherited channel permission.
Later evidence may update the display and graph without another pickup, receipt
ordinal or message ID. That change alone grants no new automatic dispatch action.

<a id="admission"></a>
<a id="channel-accepted"></a>
<a id="invitation-consumed"></a>

## 4. Invitation consumption

`invitation.consumed` automatically assigns a one-use OOB invitation to the
peer authenticated by an exact receipt. Consumption is independent of sending,
automatic output, preparation, rotation, ACK/error attribution and display; it
grants no channel or continuity authority. Its data has exactly two fields and
`roots` is empty:

```json
{
  "type": "invitation.consumed",
  "roots": [],
  "data": {
    "disclosureEventId": "019b2a61-84d8-734a-a996-963bb503e30f",
    "sourceEventId": "019b2a71-4c18-760a-9017-b3e265aa89d1"
  }
}
```

Both references are required, non-null and already committed:

- `disclosureEventId` names one `did.disclosed` with `as == "oob"` and
  `uses == "one"`;
- `sourceEventId` names one complete source witness under section 6, with
  `fromPrior == null`, the disclosure's exact local recipient DID and
  `pthid == disclosure.oobId`.

The consumer is the source's canonical peer DID within the disclosure's fixed
local DID. Validated long and short DID spellings identify the same consumer;
continuity does not transfer consumption to a successor peer.

The active runtime MUST process consumption automatically under the operation
lock, checking invitation policy, local DID/route lifecycle, denial, supersession,
conflicts and availability.
For an unconsumed disclosure, process retained non-erased proof-free receipts
matching its local recipient and `oobId` in ascending
`receiptOrderKey` order under [vault events](vault-events.md#message-in).
Select the first eligible receipt, skipping definitively invalid or currently
refused candidates. Missing evidence or unresolved eligibility at an earlier
candidate defers selection; a receipt-integrity conflict leaves it conflicted.
Commit the consumption before presenting it as complete.

Reuse a complete consumption for the same disclosure and canonical peer;
another peer cannot consume an unavailable invitation. Imported complete
records naming different consumers make it conflicted and unavailable, with
no event-order winner. Incomplete records that could establish another consumer
leave availability pending; another receipt cannot replace their exact source.
Validate each record's positive evidence before aggregate availability, so a
consumption does not invalidate itself.

Complete consumption never reopens, including after erasure, denial, retirement,
conflict or contact deletion. Retain its event and exact source/disclosure
skeletons. Import validates the references, not past policy or the producer's
then-visible receipt set; later receipts cannot replace the consumer.

On reopen, restore, import or evidence recovery, rebuild existing consumption
first. The active runtime MUST then automatically complete missing consumption
under the same ordering and current eligibility checks, without redelivery or
user action. A pure fold never appends events; missing evidence stays pending
and erased input cannot start consumption. This local recovery grants no
dispatch action. Many-use invitations have no consumption event or exclusive
consumer. Consumption never disables the disclosed DID.

<a id="continuity"></a>
<a id="channel-linked"></a>

## 5. Derived continuity

The graph folds retained proof evidence and local rotation decisions.
Network resolution and event appends belong to producer/recovery operations.

<a id="message-frompriorresolved"></a>

### Peer proof evidence

`message.fromPriorResolved` associates one received proof with the exact
predecessor document obtained for its verification. Its closed data has only
these two fields; `roots` contains exactly `documentCid`:

```json
{
  "type": "message.fromPriorResolved",
  "roots": ["bafkrei...predecessor-document"],
  "data": {
    "sourceEventId": "019b2a81-4c18-760a-9017-b3e265aa89d1",
    "documentCid": "bafkrei...predecessor-document"
  }
}
```

The exact source is an already committed authenticated `message.in` with a
non-null original `fromPrior`. The document is the method-valid issuer document,
stored as raw RFC 8785 canonical JSON under the same representation rules as
[resolution evidence](vault-events.md#peer-resolved). Obtain it under
[predecessor resolution](relationships.md#predecessor-resolution). This event
records a resolution result, not a trusted Boolean verification result. It may
retain a document that does not authorize the JWT key or fails to verify its
signature; the fold computes that failure. Its source reference supplies the
sender, local endpoint and original JWT.

For a complete authenticated carrier `M` addressed to local DID `A`, validate
the original JWT's signature, `kid`, `iss`, `sub` and retained document under
[the proof checks](vault-events.md#relationship-peertransitioned). Its `sub`
must match the carrier's authenticated sender. Then derive:

```text
B0 = canonicalDid(fromPrior.iss)
B1 = canonicalDid(M.from)
peer link = C(A, B0) -> C(A, B1)
```

`A`, `B0` and `B1` must form two valid distinct channel pairs, with `B0 != B1`.
The authenticated carrier fixes `A` and `B1`; the verified proof fixes `B0`.
These facts suffice to derive the link without an earlier message in `C(A,B0)`.
A missing source or endpoint dependency defers the link. Operations using it
still follow section 6.

A complete proof witness can serve another independently authenticated carrier
with the same compact JWT, canonical sender and canonical local recipient.
Each witness uses one exact source/document association; fields cannot be
assembled from different incomplete rows. Retained valid witnesses remain
usable after later rotation; a failed check or missing sibling does not
erase them. Without a valid witness, missing known dependencies mean pending;
otherwise complete failed checks mean invalid. Intrinsically invalid claims
cannot be repaired by another document. Arbitrary historical documents with
no such source association grant no proof authority.

<a id="did-rotationselected"></a>

### Local rotation decisions

A local rotation may be selected before any outbound message exists. Preserve
that decision as `did.rotationSelected`, with `roots == []` and five closed fields:

```json
{
  "type": "did.rotationSelected",
  "roots": [],
  "data": {
    "fromDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "peerDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "toDidId": "019b4d12-22d3-7fd0-82fb-f33864a75dd5",
    "sourceEventId": null,
    "fromPrior": "<compact-jwt>"
  }
}
```

`fromDidId` names the already committed local DID `A0`; `peerDid` stores the
canonical peer DID `B`. They fix the oriented old pair `C(A0,B)`, including
when `sourceEventId` is null. `toDidId` names an eligible local DID `A1`, distinct
from both old endpoints; its `did.created` is committed earlier or in the same
atomic commit as this decision. Its document and route come from that creation.
Validate both local DID entities and their exact retained
key evidence. The original JWT is signed by the retained local `A0`
authentication method, with exact `iss`/`sub` spellings for `A0`/`A1`.
Peer resolution is not supplied by this local signature;
each outgoing package retains its own peer resolution.

`sourceEventId` is null for manual rotation; otherwise it MUST name the complete
source witness in `C(A0,B)` selected by the live privacy policy.
The producer rechecks local lifecycle, denial, conflicts and operation-specific
policy under the operation lock, including peer supersession for source-derived
work. It requires
exact-address confirmation of `A0` by a complete source witness in the same
peer context. That confirmation needs no prior handler
execution or reply and MUST NOT depend on the rotation being selected.

Commit the decision before any dependent intent or disclosure.
The local rotation context of `C(A0,B)` contains all channels retaining local
DID `A0` and connected through verified peer-only replacements under section 5.1.
A producer MUST NOT commit a decision from `A0` when a decision from `A0`
already exists anywhere in that context. Under the operation lock, fold all
available evidence before checking this condition. Reuse the existing successor
and frozen proof; verified joins carry that choice to the related peer pairs.
Do not create another decision or notification selection, or retarget the
original notification. Missing dependencies defer reuse instead of authorizing
allocation. A missing original notification remains manual work under the
ordinary recovery rules. Evidence verified only after decisions were committed
can still reveal a conflict under section 5.1.
A decision extending an earlier successor requires exact-address confirmation
of that successor in the applicable peer context. Confirmation permits extension,
not another branch from the earlier predecessor. The fold derives
`C(A0,B) -> C(A1,B)` from this decision,
with both pairs fixed by the decision's fields and referenced local entities.
The same `A0` used with an unrelated peer defines a different rotation context.
A prepared message carrying this local proof must match the selected decision;
it cannot independently select another rotation. Recovery of the decision
grants no dispatch action.

### 5.1 Both endpoints can rotate

At the same exact `C(A0,B0)`, a valid local decision deriving `C(A1,B0)` and a
verified peer carrier deriving `C(A0,B1)` justify `C(A1,B1)`. They must share
the same oriented predecessor DID pair with complete decision and proof
evidence. Operations validate the decision and carrier, not graph rows.
The joined channel's local DID is the local link's successor; its peer DID is
the peer link's successor. Each operation in the joined channel retains its
own required peer resolution evidence for its exact immutable endpoint
documents. This is a derived join, not a fabricated received message or
fabricated wire proof.

```mermaid
flowchart LR
    C00["C(A0,B0)"] -->|local proof| C10["C(A1,B0)"]
    C00 -->|peer proof| C01["C(A0,B1)"]
    C10 -. verified join .-> C11["C(A1,B1)"]
    C01 -. verified join .-> C11
```

Only these evidence-backed joins are permitted. Sharing a DID, key or contact
cannot fill a missing side. Competing successors for the same
endpoint/context, cycles and contradictory identity evidence are visible
conflicts, not ordinary opposite-side rotation.

For peer replacements, one context includes channels connected by validated
local-only replacements while retaining the same canonical peer DID. Compare
competing peer successors across that context. For local replacements,
apply the symmetric rule through
peer-only replacements. A join transports the existing two replacements; it
does not create another competing choice. Each derived link exposes its exact
source witnesses; equivalent DID spellings neither split the context nor hide
competing successors. These contexts are derived queries; message identifiers
remain fixed by their actual channel and sender.

Compute the least positive closure of links and joins from complete peer proof
witnesses and local decisions. A local decision's predecessor confirmation
must be supported without that decision or its descendants. Pure reference
cycles with no independent evidence grant nothing. Fold the full
available evidence before checking current conflicts or authorizing new work;
enumeration order and intermediate graph rows cannot authorize dispatch.

### 5.2 Supersession, confirmation and authorization

A verified peer link stops new application work from its old peer in
that channel context. The same peer supersession applies through verified
local-only links in that context, including either end of those local links;
local address rotation cannot restore the old peer's authority. It does not
affect an unrelated channel using the same public peer DID. In a verified join,
the peer link supplies this same supersession fact at the joined local endpoint.

A complete source witness can confirm knowledge of an exact local address
when its recipient is that address and its authenticated peer is the selected
peer or a verified role-preserving successor in the same local-only/paired-link
context. An observation addressed to a predecessor confirms no successor.
No handler execution or reply prerequisite is imposed on
that witness. Confirmation permits future newly prepared messages to omit the
frozen proof; it does not edit a committed package or acknowledge
any particular wire ID.

For ACK authorization, a path preserves endpoint roles and uses verified
forward replacements and the joins above. It relates a specific old channel
to a specific successor channel. General undirected graph connectivity never
authorizes ACKs, sending or protocol effects. An unrelated channel in the same
contact cannot acknowledge a message even when it chooses the same wire ID.

<a id="message-scoped"></a>
<a id="message-accepted"></a>
<a id="operation-eligibility"></a>

## 6. Operation eligibility

Each operation checks its evidence and current policy before recording its
intent, local decision or result.

A **complete source witness** is one authenticated `message.in` with a valid
local recipient/key mapping, canonical sender and its own exact resolution
document. Its actual DID pair fixes its channel. A carried proof also requires
its valid derived peer link under section 5. Proof-free input needs no
continuity witness. Equivalent proof carriers may supply a complete
proof witness, but cannot supply this source's sender authentication or replace
its immutable claims. Missing exact references defer the affected consumer;
incompatible authentication, intent or continuity evidence conflicts.

Before creating a new automatic intent, the producer checks its complete
source witness under the operation lock, current denial, supersession, local
lifecycle, operation-specific policy and any existing equivalent intent.
Local rotation follows section 5's endpoint, proof and confirmation rules,
including its exact source when present. A user send without an inbound source
follows the user-send rules. Automatic intents retain their exact source;
rotation decisions retain their fixed pair, successor, proof and nullable source.
Each record establishes only that operation's local choice.
All referenced events must be committed first. No intent can supply
its own source authentication or continuity proof.

Import/rebuild validates each saved action's evidence references and protocol
rules, not the producer's past wall-clock policy. Ordinary later rotation
or blocking does not erase an earlier intent, local result or recorded
submission. Current denial, expiry and conflicts still govern new work and
dispatch. Peer supersession governs new work derived from old-peer input; it
does not by itself block an explicit user send to an eligible pre-rotation
address or manual dispatch of a committed intent. Retaining history supplies
no dispatch action.
Incomplete consistent siblings do not erase a complete witness. Different
incomplete rows cannot be assembled into one witness.

Received ACKs and Report Problem correlation are observations, not commands.
They require a complete source witness and the exact target/path checks,
including protocol thread correlation for Report Problem, but no handler
decision. Current blocking or supersession does not
erase evidence that the peer acknowledged an old message; invalid/conflicting
evidence still prevents attribution.
Body erasure preserves committed event facts but prevents new content-derived
work and invalidates display data that requires the erased bytes under
[application views](vault-events.md#application-message-views).

<a id="effects-and-recovery"></a>

## 7. Identity, local policy and display

The logical inbound identity is `(canonical sender DID, canonical recipient DID, wire ID)`.
Key variants independently authorized by the same immutable DID document can
agree on that one input; intent differences conflict. Another channel always
has another logical input and
execution ID, even if its wire ID/content is equal and continuity is proven.
Neither later graph discovery nor grouping merges executions. The ID formulas
and within-channel vectors are in [delivery](distributed-delivery.md#observation-ids-and-vectors).

ACK, Ping reply and rotation notification are independent concrete intents
with distinct deterministic tuples. Each tuple permits one immutable intent.
Only the single active executor may react automatically to eligible live input;
historical input and mailbox fan-out follow section 8's dispatch rules.

<a id="channel-blocked"></a>

### 7.1 Blocking

`channel.blocked` has `roots == []` and three required data fields:

```json
{
  "type": "channel.blocked",
  "roots": [],
  "data": {
    "localDid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
    "peerDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "includeSuccessors": true
  }
}
```

The DID pair obeys section 2's selector rules; `includeSuccessors` is Boolean.
It is a permanent local denial decision for that channel; when true it also
covers evidence-backed successors through directed links/joins. Missing
required evidence defers inheritance and supplies no continuity authority;
each operation still checks its own evidence and policy. Known contradictory
authority prevents new work. It does not prevent authenticated receipt/pickup
ACK or infer a global block of a DID.

<a id="display-relationships"></a>
<a id="contact-channels"></a>

### 7.2 Contacts and channel views

`contact.channelsSet` directly selects a contact's channels under
[the contact membership schema](vault-events.md#contact-channelsset).
Two channels sharing a peer DID at different local addresses remain independently
selectable. [Contact creation](vault-events.md#contact-created) records a non-empty
initial set; clearing it leaves no contact-based send choice.

A UI MAY traverse verified continuity from the selected channels to display
related history. New user sends follow the head-selection rule in section 8.
This traversal is a rebuildable view, not a membership update or a stable
chain/component ID.
Pending, invalid or conflicted evidence cannot silently establish continuity.
The UI MUST distinguish selected channels from derived related history.
Missing evidence may change the derived view without changing the saved selection.
Unassigned channels may be browsed directly.

A product's explicit "delete and block" action separately appends denial
decisions for the concrete selected channels and optional successors; later
contact membership changes cannot expand or remove them. Application views
retain their source channels even when a contact displays data from several chains.

<a id="fixed-outbound-channel"></a>

## 8. Fixed outbound channel and dispatch authority

For a new user send, follow complete verified role-preserving links and joins
from each selected channel to its unique non-conflicted **head**: a reachable
channel with no further verified forward replacement. A predecessor of such a
link or join is replaced for default selection. Fold the complete available
graph before selecting; opposite-side paths that join at the same head supply
one choice. Competing same-end successors or a cycle leave no default in the
affected context. An ineligible head supplies no default and MUST NOT silently
fall back to a predecessor.

For contact-based sending, `writeTo[]` contains the distinct eligible heads of
the selected contexts. A `contact.useDid` preference also matches verified local
successors of its DID along forward paths in those contexts. It grants no path
to an unrelated channel sharing that DID. After applying any saved preference,
exactly one eligible head supplies the default; otherwise the user must select
a concrete eligible channel. A replaced channel may be used only by an
explicit choice labelled as a pre-rotation address, subject to all ordinary
send restrictions. Replacement for default selection does not itself prohibit
that explicit send. Peer supersession under section 5.2 instead governs new
work derived from old-peer input. Automatic replies follow their protocol's
selection rules
under [delivery](distributed-delivery.md#built-in-independent-operations).

`message.out` freezes `senderDidId` and `recipientDid` before preparation or
transport. This immutable channel avoids relying on recovery to prove that an
earlier call did not occur.

Rotation selects addresses for new messages only and MUST NOT move an existing
intent, including an unprepared or automatic one, to another channel.
If that channel can no longer send, retain the original outcome and require an
explicit new send with a new wire ID to use a successor channel. Message IDs,
automatic effect IDs and frozen ACK arrays are never rewritten to follow it.

Before transport, commit `message.prepared` to freeze one package for the
message. Every call uses that package's exact bytes and ID, including the first
call and manual retries. Later rotation, confirmation or termination cannot
replace it. Missing package bytes/evidence defer sending; conflicting prepared
packages suppress it without an event-order winner. An uncertain preparation
commit must be resolved before dispatch or further preparation.

An initial send may run only from the live local user action or eligible
live input that created its intent. Resolving, preparing and registering before
that initial call may wait/retry locally. After a transport call fails or its
outcome becomes uncertain, another call requires a fresh explicit manual retry.
Reopen, import, restore, replica change, duplicate receipt, rotation and loss of
local state supply no dispatch authority.

A manual retry of an uncompleted message preserves the exact channel, wire ID,
package ID and envelope; check current expiry, erasure, retained keys, route,
security restrictions and content availability again. A submitted or terminal
message cannot retry. A deliberate new send, including a send over a new
channel, creates a new message ID. Any local UI link to the old message is
informative and cannot alias execution or imply that the first send failed.

Recovery exposes pending messages for manual action. A prepared package does
not prove a call occurred, and missing submission does not prove nondelivery.
Rebuilding receipt-derived views grants no dispatch action. Phase 1 permits one
active executor; mailbox fan-out does not authorize other replicas to respond.

An explicit manual action may complete pending protocol-response work when
its source, channel authority and content remain eligible. It reuses the
source's deterministic execution/tuple and any already frozen response. If no
response intent exists, it may select one under the normal response rules;
its first dispatch is manual. It cannot reopen a submitted/erased response or
use another tuple to bypass an existing selection or conflict.

Sender policy alone cannot constrain an external peer. Cross-channel reuse of
a wire ID is not a channel-local duplicate, and this profile provides no
cross-channel exactly-once guarantee. Protocols needing business idempotency
must define an authenticated application operation ID and its own rules.

<a id="required-conformance-cases"></a>

## 9. Required conformance cases

Entries marked Deferred preserve their case IDs but are not phase-1 requirements.

1. <a id="ch-1"></a> A channel is an ordered local/peer canonical DID pair, independent of keys, routes and contacts. Local sending and peer receipt share that pair; reversing local/peer roles selects a different vault-local view.
2. <a id="ch-2"></a> First authenticated receipt commits and pickup-ACKs without invitation consumption, continuity history or a contact.
3. <a id="ch-3"></a> A valid retained proof with complete authenticated source and endpoints derives its link without an earlier predecessor-channel message. Invitation state cannot make it pending-history; recovering required evidence adds no receipt or stored graph event.
4. <a id="ch-4"></a> A recovered peer supersession refuses new old-peer input through its local-only context while preserving channel receipt and previous decisions.
5. <a id="ch-5"></a> Complete independent local/peer links at one exact predecessor pair justify their diagonal join without synthetic observations; unrelated shared DIDs justify nothing.
6. <a id="ch-6"></a> Observations with the same sender/recipient/wire-ID triple, equal intent and authorized keys share one execution. Another channel has another execution.
7. <a id="ch-7"></a> Contradictory authenticated intent with complete source witnesses suppresses new effects; previously submitted IDs and outcomes remain unchanged.
8. <a id="ch-8"></a> Unknown policy, missing verification evidence and invalid continuity leave receipts intact and grant no effects.
9. <a id="ch-9"></a> A retained channel denial applies independently of contact membership; deleting a contact alone grants or revokes no cryptographic authority.
10. <a id="ch-10"></a> Crash after receipt, proof-resolution association, invitation consumption or a concrete intent/result preserves each committed fact; reopen rebuilds verification and pending-work views without dispatching old work.
11. <a id="ch-11"></a> Competing one-use invite receipts can both be saved; only a complete invitation.consumed records a consumer. Crash, erasure, denial and retirement never reopen that consumption.
12. <a id="ch-12"></a> Missing recoverable local receive material waits without pickup ACK; current-sender resolution uses its bounded sequence. Definitive envelope/authentication rejection pickup-ACKs without an observation. Missing predecessor proof material is never a pre-receipt wait.
13. <a id="ch-13"></a> One-use consumption is automatic and needs no additional user decision. Select the first eligible non-erased receipt in receiptOrderKey order; an earlier candidate with missing evidence defers selection. Timeout, control type and matching pthid alone establish no consumption.
14. <a id="ch-14"></a> A peer link applies only in its validated channel/local-continuation context and does not replace the peer in unrelated public-DID channels.
15. <a id="ch-15"></a> Earlier source evidence, intents and results survive ordinary rotation and later extensions; contradictory identity evidence or same-end successors suppress new work without rewriting identity.
16. <a id="ch-16"></a> Retained retired recipient keys can drain eligible routes; new sending, disclosure and invitation consumption obey retirement.
17. <a id="ch-17"></a> An incomplete consistent sibling cannot create another same-channel execution or erase a complete witness. Cross-channel observations never merge executions.
18. <a id="ch-18"></a> Recovery uses retained authentication evidence without fresh resolution of a saved receipt; new network deliveries authenticate afresh.
19. <a id="ch-19"></a> Intent freezes its oriented channel; local or peer rotation changes only new intents, including when the old intent has no package yet.
20. <a id="ch-20"></a> Commit the fixed package before transport. Crashes immediately before the call and after transport acceptance both reopen without automatic submission or proof of whether the call occurred.
21. <a id="ch-21"></a> Initial send and manual retry use the committed package exactly, even if it has never been sent. Missing bytes defer; changing package or channel requires a new message ID.
22. <a id="ch-22"></a> Import, restore, replica change, duplicate pickup and missing ACK never dispatch an old intent or regenerate an automatic response for sending.
23. <a id="ch-23"></a> Submitted or terminal messages cannot retry. Deliberate new sends get new IDs and do not establish that the original was undelivered.
24. <a id="ch-24"></a> Missing submission grants no automatic recovery sending; incomplete exact references remain pending, and conflicting prepared packages prevent sending without selecting an event-order winner.
25. <a id="ch-25"></a> Renaming or merging contacts and changing their channel sets changes no message/execution ID, ACK authorization, verification evidence, denials or invitations.
26. <a id="ch-26"></a> A successor-channel ACK needs a verified role-preserving path to the exact outbound; general connectivity or shared display membership is insufficient.
27. <a id="ch-27"></a> Swapping sender and recipient with the same wire ID produces different inbound/execution identities; changing either endpoint also changes those identities.
28. <a id="ch-28"></a> A cyclic proof/rotation-confirmation dependency grants no continuity authority. Invitation consumption cannot supply missing proof, endpoint or confirmation evidence.
29. <a id="ch-29"></a> Learning a missing graph link after independent channel executions never merges or replays those executions.
30. <a id="ch-30"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#ch-30).
31. <a id="ch-31"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#ch-31).
32. <a id="ch-32"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#ch-32).
33. <a id="ch-33"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#ch-33).

34. <a id="ch-34"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#ch-34).

35. <a id="ch-35"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#ch-35).

36. <a id="ch-36"></a> The phase-1 adapter authenticates a carrier without resolving its predecessor. Receipt commits and pickup-ACKs with the exact original from_prior; UI shows pending-proof and no verified peer continuity or application effect. Proof failure never changes the authenticated source used for ingress limits.
37. <a id="ch-37"></a> Saving a method-valid proof document and deriving its link need no earlier predecessor-channel message. A valid signature with a missing required source/endpoint/rotation record shows pending-history for that path; restoring it completes the path without another proof lookup.
38. <a id="ch-38"></a> A malformed string-valued carried JWT, wrong sub or complete failed signature check shows invalid while preserving authenticated receipt and pickup ACK. A valid short-form issuer without local long-form material stays pending-proof. Tampered envelope integrity or mismatched current-sender/recipient evidence still fails the receive gate and creates no message.in.

39. <a id="ch-39"></a> Importing missing proof/history updates verification status, links and eligible ACK projections without a new receipt ordinal, input identity or automatic reply/notification dispatch.
40. <a id="ch-40"></a> Rebuilding from receipts, exact document associations and local decisions yields the same graph and verification statuses in any import order. No consumer references a link/status projection row as an event.
41. <a id="ch-41"></a> A local rotation decision fixes fromDidId, canonical peerDid, toDidId, nullable sourceEventId and fromPrior, and survives a crash before any outbound exists. A manual decision still fixes its peer with a null source; another peer sharing the old local DID cannot inherit it. Later preparation reuses its exact successor and JWT; merely preparing a package cannot select a competing rotation.
42. <a id="ch-42"></a> One complete valid proof witness survives a later failed snapshot check or incomplete sibling. With no valid witness, missing required references remain pending; different incomplete rows cannot be combined into success.
43. <a id="ch-43"></a> An unassigned channel supports receipt, sending and continuity without a contact. Contact creation is a separate product decision.
44. <a id="ch-44"></a> Two channels sharing a peer DID but using different local DIDs can be selected independently for a contact. Selection does not globally associate that peer DID's channels.
45. <a id="ch-45"></a> Newly verified continuity may extend a contact's derived history or eligible send choices without changing contact.channelsSet. Missing/conflicting evidence changes only the affected view or eligibility; no stable chain ID or automatic send is created.
46. <a id="ch-46"></a> Contact and block selectors compare both canonical localDid and peerDid. The same peer at another local DID stays separate; successor blocking requires a verified directed path from the selected pair.
47. <a id="ch-47"></a> One invitation fixes its local recipient. Consumption by the same canonical peer is idempotent across validated long/short spelling; another peer conflicts, while another disclosure with a distinct oobId at a different local DID has independent consumption. Verified peer rotation neither transfers nor reopens the recorded consumption.

48. <a id="ch-48"></a> Missing exact local-DID or peer-resolution evidence leaves a source-derived pair pending. Another event, contact selector or shared key cannot substitute for that evidence; restoring it derives the same pair without changing saved message identities.
49. <a id="ch-49"></a> Without consuming an invitation, a complete live source may produce a policy-permitted automatic intent, its valid fixed-channel package and a local rotation with independent exact-address confirmation. Import validates their own source, endpoints and proof and never dispatches them.
50. <a id="ch-50"></a> An invitation consumption with a missing exact disclosure or source remains pending even if another receipt could independently justify the same consumer. That wait cannot block complete links, joins, rotation notifications or another operation with complete evidence.
51. <a id="ch-51"></a> Without consuming an invitation, an application may derive channel-scoped display data from a complete source and readable non-erased content under its protocol and display policy. Missing authentication or required proof prevents a verified claim; derived data creates no contact, changes no petname and grants no dispatch action.
52. <a id="ch-52"></a> Without consuming an invitation, a complete authenticated ACK or Report Problem carrier can be attributed to its exact outbound through a valid same-channel or role-preserving successor path and the required ID/thread match. An unrelated peer knowing the ID cannot supply attribution. These observations neither establish submission nor authorize retry.
53. <a id="ch-53"></a> Many-use and non-OOB disclosures cannot be consumed. Republishing an invitation reuses its disclosure; distinct imported OOB disclosures with the same non-null oobId conflict and cannot supply another use or reopen prior consumption.
54. <a id="ch-54"></a> Consumption requires already committed disclosure and source references, not same-batch prerequisites. After a crash before consumption commit, recovery automatically records the first currently eligible retained source; after commit, recovery preserves that consumer even if an earlier receipt is imported. Erased or currently refused input starts no consumption. Neither crash prefix dispatches a reply or disables the disclosed DID.
55. <a id="ch-55"></a> A selected C(A0,B0) with verified local and peer replacements defaults to the unique joined head C(A1,B1), including when contact.useDid still names A0. An unusable head, competing same-end successors or a cycle never defaults back. An explicit pre-rotation user send to C(A,B0) after verified replacement by B1 is permitted subject to ordinary denial, conflict, key/route and other send restrictions. New automatic work from B0 input is refused; an already committed old-peer intent keeps its original channel and may be manually dispatched when otherwise eligible. Import order changes none of these saved endpoints.

56. <a id="ch-56"></a> Repeated rotation work reuses the decision from the same local predecessor throughout its verified peer-only context, before and after successor confirmation. After (A0,B0) selects A1, a valid B0-to-B1 carrier at A0 cannot select A2 or another notification; new user sends default to C(A1,B1). Extending A1 to A2 requires independent exact-address confirmation of A1. A newly allocated successor and its decision commit atomically; evidence learned later can still expose competing decisions without choosing a winner.
