# Channel graph and derived continuity scopes

Status: **candidate specification, not the active phase-1 profile**.

[Suite guide](README.md) · [Conformance](#conformance) · [Integration map](#integration)

This is a spec-only alternative to the relationship-first domain model at
`2ba55d33bf2859da909c2f496b1b4e4111d32d3d`. Requirements in this document apply to
the candidate, not implicitly to the existing phase-1 specifications. It does
not change implemented behavior, the SQLite format version, or the wire protocol.
The baseline remains the implementation reference until this candidate is
explicitly adopted. Do not implement a mixture of the two acceptance models.

The candidate removes the first-class relationship aggregate. It keeps channels,
local contacts, immutable continuity evidence and a **derived, origin-anchored
protocol scope**. The scope is not a contact and is not an arbitrarily mergeable
connected component. An immutable origin witness remains necessary; removing a
relationship entity does not remove the need to justify protocol continuity.

MUST, MUST NOT, SHOULD and MAY are normative within this candidate as in BCP 14.
The event payloads below specify the proposed domain delta; the integration map
identifies the existing schemas and procedures that adoption must replace.

<a id="model"></a>

## 1. Model and boundaries

| Concept | Meaning | Persistence |
| --- | --- | --- |
| Channel | An immutable pair of authenticated DID/key endpoint contexts | Derived from retained observations, preparations and exact endpoint evidence |
| Observation | What a particular authenticated envelope actually said and used | Immutable event and held content/evidence |
| Contact | Local grouping, labels, discovery hints and preferences | Local decision events, independent of continuity |
| Continuity evidence | A rooted origin and verified, directed endpoint changes | Immutable origin/edge events with exact witnesses |
| Protocol scope | The stable authority and execution namespace derived from one origin and its valid evidence | Fold; no `relationship.created`, mutable membership set or authoritative current-end row |
| Admission | Permission to interpret an observation in exactly one protocol scope | Immutable evidence references, separate from receipt |

```text
observations / prepared packages ----> channels
                                        ^
contacts -------------------- group ----|
                                        |
origin + typed continuity evidence -----+----> derived scopes
                                                  |
observation + complete scope evidence ----> admission ----> ACK / effects
```

A channel can be observed, stored and addressed without a contact or an admitted
scope. Several unrelated scopes can appear in the same contact. Labels, contact
merge/split and discovery hints MUST NOT establish continuity, merge execution
namespaces or change the identity of an already committed intent or effect.
Explicit local blocking may deny future interaction without changing those facts.

Protocol threads remain conversations *inside* an authorized scope. A `thid`,
`pthid`, equal key, display name, shared route or shared public DID is not evidence
that two scopes are equivalent. There is no new wire relationship/scope field and
no extra Estoc handshake. Internal channel, scope and event IDs are not disclosed
to peers or mediators merely to communicate.

This candidate retains one active writable full runtime. Generic delegation,
parallel device authority, branching rotation, cross-origin merging and
multi-writer exactly-once execution are not defined here. In particular, standard
DIDComm `from_prior` is replacement evidence, not a general delegation mechanism.

<a id="identifiers"></a>

## 2. Identities and exact authentication context

Use the existing [UUID namespace derivation](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces),
[DID canonicalization](relationships.md#peer-did-numalgo-4-profile) and
[public-key representation](vault-events.md#key-evidence). A validated Peer DID
numalgo-4 long form uses its canonical short form in identities. Never discover
aliases by comparing keys or endpoints.

An authenticated application endpoint descriptor is the array:

```text
E = [canonicalDid, "keyAgreement", canonicalPublicKey]
```

The actual authenticated method ID, its purpose, the exact presented DID spelling
and its authorizing document are REQUIRED evidence even though the method fragment
and document CID are not in E. Two references to the same key material in the same
DID/purpose have the same descriptor; this does not waive exact-method validation.
The same key under different DIDs has different descriptors. A different selected
key makes a different channel, including when both keys occur in one document.

A channel has two distinct canonical DIDs. Local-local communication, anonymous
input and signed-only input are outside this candidate's authenticated application
channel profile; mediator control remains outside application execution scopes.
No authenticated peer is inferred from an anoncrypt recipient or plaintext `from`.

Let `ordered` sort strings by unsigned UTF-8 bytes, not locale collation. Sort
endpoint descriptors by the UTF-8 bytes of their RFC 8785 serialization. Define:

```text
[Elo, Ehi] = orderedEndpointDescriptors(localEndpoint, peerEndpoint)
channelId = UUIDv5(estocNamespace("channel"),
                   UTF8(RFC8785(["v1", Elo, Ehi])))

[Dlo, Dhi] = ordered(canonicalLocalOriginDid, canonicalPeerOriginDid)
scopeId = UUIDv5(estocNamespace("continuity-scope"),
                 UTF8(RFC8785(["v1", Dlo, Dhi])))

observationMessageId = UUIDv5(estocNamespace("channel-observation"),
  UTF8(RFC8785(["v1", channelId, canonicalSenderDid,
               authenticatedPeerPublicKey, wireMessageId])))

executionId = UUIDv5(estocNamespace("message-execution"),
  UTF8(RFC8785(["v3", {"scope": scopeId, "sender": canonicalPeerOriginDid},
               wireMessageId])))
```

Both orientations derive the same channel/scope IDs. The execution transcript
identifies the *origin* sender end, not its latest DID/key or the current contact.
Opposite senders reusing a wire ID have different execution IDs. The `v3` transcript
is intentionally different from the baseline `v2` relationship transcript.

`message.observed.messageId` uses `observationMessageId`. Several exact observation
events may share it. Different intent hashes in that group conflict; different
plaintext hashes alone may be legitimate package variants. Cross-channel logical
identity is established only after admission, using `executionId`.

All these IDs are names, not capabilities or proofs. Local key names, replica IDs,
contact IDs, selected route, document retrieval time and the current graph member
set do not enter them. A scope is never the minimum member ID or a hash of a
connected component. Learning a new channel/edge cannot rename a scope.

### 2.1 Identifier-only vectors

These synthetic canonical endpoints are identifier fixtures, not DID resolver,
JWT, key-control or encryption test vectors. Their keys encode the X25519
multicodec prefix followed by byte sequences 0..31 and 32..63 respectively.

```text
localEndpoint = ["did:example:alice0", "keyAgreement",
                 "z6LSbgC4DpuCf7zxewhFPnYcyBm3YgxjEEovsehvWqZzTm8z"]
peerEndpoint  = ["did:example:bob0", "keyAgreement",
                 "z6LSdqbWoToXafWD7qhVMLz2HCTTMmhAnGnAki2vP11ANRTc"]
wireMessageId = "019b1b61-3444-7190-9db5-1cc9c215eb23"
```

| Derived value | Expected UUID |
| --- | --- |
| Channel, either orientation | `89a135f8-08db-5805-b80d-b3d2b7bb737b` |
| Origin scope, either orientation | `fb69b171-e36c-5553-9acc-f8b32733d02f` |
| Inbound observation group, Bob sender | `d5034d0c-4bea-5d30-8085-d834dd412b75` |
| Execution, Bob origin sender | `c853ce4c-cb26-5b78-906b-902146a2d6c8` |
| Execution, Alice origin sender | `d2fbf4b1-c72d-54b9-bcf3-9b34b337f6cb` |
| Automatic contact, section 9 | `a9536788-1bca-5db5-87de-b40261db78ff` |

<a id="evidence"></a>

## 3. Proposed durable evidence

All writes use the existing process-durable `Vault.commit(objects, drafts)`
contract. Typed references MUST name the required event type. Missing references
are missing evidence, not nulls; present incompatible references conflict.
Definitions below are payload deltas, not permission to drop the baseline's
content, authentication, header, hash, lifecycle or integrity checks.

### 3.1 `message.observed`: receipt without attribution

Replace the baseline `message.in` receipt payload with its existing content,
attachment, receipt ordinal, wire-header, exact-resolution, local-method and
transport fields, with these changes:

```text
messageId                    = observationMessageId from section 2
channelId                    = channel derived from exact authenticated endpoints
peerResolutionEventId        = exact current sender authentication evidence
localKeyName                 = actual successful local key-agreement method
relationshipBindingEventId   = removed
peerTransitionEventId        = removed
```

The exact `fromPrior`, including an unverified continuation claim, is retained
in the observation header together with the intent/plaintext hashes and source
spellings. It is not marked verified merely because authcrypt succeeded. The
source resolution and local document/key evidence MUST suffice to reproduce the
channel and the envelope authentication decision. A list of recipient kids is
not proof that an arbitrary listed key was the successful local recipient.

Each exact observation event is a complete witness. Implementations MUST NOT
assemble a witness from the local key of one duplicate, the proof of another and
the resolution of a third. `message.observed` means authenticated *envelope
observation*, not accepted application input or fully validated DID rotation.

No `channel.created` event is needed just to record a channel. Its evidence can be
folded from observations and preparations; an optional cache is non-authoritative.

### 3.2 `channel.origin`: an immutable origin witness

```text
scopeId: ScopeId
localDidId: DidId
peerResolutionEventId: EventReference<peer.resolved>
source:
  { kind: "observed", eventId: EventReference<message.observed> }
  | { kind: "outbound", messageId: MessageId }
```

This pins the initial local DID/document and the exact peer document. Their
canonical DID pair derives `scopeId`. Both documents' authorized key-agreement
methods seed the two endpoint histories; a selected key is not the entire
initial authorization set. A source observation must use that local root and an
authenticated key authorized by that peer snapshot. An outbound source must be
a committed user intent selecting that same original pair; a prepared package or
peer reply is not required to establish an origin witness.

An origin records the local basis for protocol identity, not peer consent or a
contact decision. Equivalent witnesses for the same pair and exact document CIDs
are duplicates. Different initial pins for one scope conflict; a fresh resolver
result cannot replace a pin. The producer reuses an existing equivalent witness
under the operation lock instead of manufacturing another snapshot.

Origin creation is optional for channel storage and exact-channel sending. It is
required before continuity-scoped admission or sending. It MUST NOT be inferred
from contact attachment, graph reachability alone or a carried unverified proof.

### 3.3 `channel.continued`: scoped, directed evidence

```text
originEventId: EventReference<channel.origin>
side: "local" | "peer"
predecessor:
  { kind: "origin", eventId: EventReference<channel.origin> }
  | { kind: "continuation", eventId: EventReference<channel.continued> }
fromPrior: exact compact JWT
successor:
  { kind: "local", didId: DidId }
  | { kind: "peer", resolutionEventId: EventReference<peer.resolved> }
witnessEventId: EventReference<message.observed> | null
confirmationEventId: EventReference<message.admitted> | null
```

`side` must agree with the successor kind. The predecessor names the exact node
on that side of the same origin; its document verifies the JWT. The JWT issuer
and subject determine distinct predecessor/successor canonical DIDs and must
match that evidence. A peer edge requires one complete observed carrier witness;
a local edge has null `witnessEventId` and must name a live, locally controlled
successor with the correctly frozen proof. A local edge after an earlier local
rotation requires that earlier successor's exact-recipient confirmation in the
same origin through a complete, conflict-free `confirmationEventId`; the first
local edge has null confirmation. Peer edges have null confirmation. Other combinations are invalid.

The origin reference is **local scope evidence**, not an additional JWT claim.
A JWT that mentions an old public DID does not globally join every channel using
that DID. The actual recipient and rooted predecessor evidence must identify one
unique scope before the peer edge is usable.

The edge replaces one endpoint in one origin. Its key-authorizations come only
from the pinned successor document. A proof-free observation using another key
already authorized by an existing pinned document needs no DID rotation edge.
A same-DID document update MUST NOT be disguised as `from_prior`; an authenticated
but unpinned new key remains unadmitted pending a separately specified update
mechanism. This candidate does not introduce that mechanism.

### 3.4 `message.admitted`: immutable interpretation

```text
observationEventId: EventReference<message.observed>
originEventId: EventReference<channel.origin>
localPathEventIds: EventReference<channel.continued>[]
peerPathEventIds: EventReference<channel.continued>[]
executionId: ExecutionId
invitationDisclosureEventId: EventReference<did.disclosed> | null
```

Paths are ordered from the origin to the actual local and peer nodes; each edge
has the appropriate side and exact preceding node. Empty means the root node.
The exact document at each endpoint must authorize the observed DID/key/method.
A carrier with `fromPrior` additionally requires the matching committed peer edge
and its complete witness, even if its endpoint is already recognized.

`executionId` MUST match section 2. Source observation, origin and required edges
must have committed before the admission call. Admission does not authorize an
automatic outbound proposed in the same batch; effect selection follows its
commit. Repeated equivalent admissions are idempotent. Admissions disagreeing
on scope or execution identity conflict, rather than picking the latest one.

Receipt can therefore precede evidence, and evidence can precede admission.
Import validates an admission's positive evidence, not the import arrival order.
A later conflict can suppress new work but cannot reassign an old admission or
rewrite an already emitted effect.

<a id="fold"></a>

## 4. Rooted fold, not union-find

For each compatible origin witness, independently validate both directed endpoint
histories. Equal edges (same origin, side, predecessor, proof, successor DID and
successor document CID) are duplicates. Competing proofs/successors, cycles,
incompatible document pins and an edge reaching another independently rooted
scope are conflicts. Missing rooted prefixes or referenced objects defer.

The fold derives:

```text
scope(origin) = {
  scopeId,
  localHistory, peerHistory,
  currentLocal, currentPeer,
  observedChannelsAuthorizedByTheseHistories,
  pendingClaims, conflicts
}
```

This is a view, not a second persisted relationship object. The histories allow
an observation at any authorized combination of local/peer history nodes to be
checked; current-sender admission policy remains separate. An implementation may
use a lazy pair index and need not materialize the Cartesian product or invent
observations for channels it has never seen. Both endpoint paths, not a pair-index
hit, supply authority.

Shared addresses/keys do not join origins. If independently valid claims assign
the same observed channel/address context to different origins, every claimant
is conflicted. Validate claims before applying conflict suppression so that
suppressing one claimant does not make another a winner. Missing evidence never
selects a provisional security scope.

A new proof-free pair can establish an origin only if it is not already covered
by a unique origin and has no known continuation claim, unresolved required
membership evidence, conflicting claim or forbidden retired origin. Check
committed observations carrying continuation claims as well as accepted edges
and queued outbound origin selections. Root selection and the origin commit use
the operation lock. Receipt itself does not need this root decision.

An unresolved carrier reserves only its exact canonical successor-DID/recipient-DID
pair (across selected keys) against *new-origin admission*. Its unverified issuer
is merely a lookup hint: it cannot create an edge, retire a DID, block unrelated pairs or confer any
rights in the claimed predecessor scope. Definitively invalid evidence supplies
no authority and cannot be converted into a fresh root by dropping its proof.

### 4.1 The late-join boundary

Suppose a proof-free C2 has already been independently rooted and executed input,
and only later an edge claims it continues C1. The runtime MUST NOT merge their
scopes, recompute past execution IDs or rerun effects under a combined identity.
It records a cross-origin conflict and suppresses affected new work. It cannot
undo external effects that ran before the relationship between inputs was known.

Known missing continuation evidence must therefore defer **admission**, not fall
back to channel-scoped application execution. The candidate makes no global
exactly-once promise for unknowably related origins. A future cross-origin merge
protocol would need explicit execution-history reconciliation; contact merge is
not that protocol. This limitation is intentional, not solved by naming a graph
component a scope.

<a id="rotation"></a>

## 5. Rotation and simultaneous endpoint changes

The cryptographic checks from the baseline
[peer transition](vault-events.md#relationship-peertransitioned) and
[local transition](vault-events.md#relationship-localtransitioned) are retained
as constraints on the evidence in section 3.3, not as relationship entities.
In particular, require the exact historical predecessor snapshot, authorized
JWT signing method, valid claims and original signing bytes, DID long/short-form
consistency, authenticated successor, exact recipient membership and a complete
carrier witness. A newly fetched document substitutes for missing historical
bytes only when its canonical raw CID equals the named pin.

The receiver selects the origin from the actual recipient and predecessor
history, not `iss` alone. Transition validation uses `message.observed` rather
than `message.admitted`, avoiding the cycle in which a carrier would need its
own admission to establish the evidence required to admit it.

Local and peer edges are independently rooted. For simultaneous A0->A1 and
B0->B1, an observation at A1/B1 is admitted when both endpoint paths are complete,
even if no message ever used A1/B0 or A0/B1. Partial imports wait for the missing
path and then converge; they do not generate an A1/B1 origin. Two changes on
different sides are not competing branches. Two incompatible successors of the
same side/predecessor are competing branches.

There is at most one unconfirmed local rotation at a time. Retain the exact JWT
on sends until an admitted observation is addressed to its exact successor;
explicit peer ACK processing remains separate. Rotation is replacement within
that scope, not a global retirement of a public address used elsewhere. New
input from a superseded peer is rejected at admission as in section 6; old
committed admissions are not retroactively invalidated by a later valid rotation.

Supporting simultaneous *devices* with parallel authority requires a distinct
authorization profile. A fork is not made legitimate by calling it delegation.

<a id="receipt"></a>

## 6. Receipt, admission and commit boundaries

| Boundary | Durable prerequisites | What it permits |
| --- | --- | --- |
| Authenticated observation | Content/headers and exact successful envelope authentication evidence | Pickup ACK for that delivery; pending-input display; evidence processing |
| Origin / continuation evidence | Exact pins, proof and required committed witness | Rooted scope derivation, not an application effect |
| Admission | Committed observation, complete unique scope evidence and acceptance checks | Scoped ACK processing and subsequent effect selection |
| Automatic intent | Committed admission and immutable producing tuple/target | Eligible preparation/submission |
| Submission completion | A committed valid `delivery.submitted` | Stop all new preparation/submission for that logical outbound |

### 6.1 Receive

1. Apply authoritative local-key/route recovery, exact-recipient, parser,
   cryptographic-envelope and hard resource gates. Before authoritative recovery,
   missing local state is not proof of a foreign recipient. A retired local DID
   with retained communication history can be a historical recipient while its
   route remains usable; a new origin at a retired DID remains forbidden.
2. Authenticate the current sender independently of claimed continuation. Keep
   the baseline current-resolution security/freshness checks, supported methods,
   bounded retries, SSRF defenses, exact `from`/key consistency and required Peer
   DID long forms. A cached identity or contact cannot bypass authentication.
3. Commit/reuse exact resolution and local evidence, then commit content and
   `message.observed`. Recheck actual recipient eligibility under the operation
   lock. No contact, origin or verified continuation is a receipt prerequisite.
4. Only after process-durable observation commit, acknowledge the mediator
   delivery. Recovery must retain everything already obtained that is needed to
   retry interpretation, including the exact JWT and its unresolved references.
5. Resolve/validate missing origin and continuation evidence from committed input.
   Missing historical bytes, ambiguous scope or pending continuity cause no new
   peer ACK, application response or fallback application execution.
6. Under the operation lock, apply admission checks and commit `message.admitted`
   with its exact witness and paths. Release the lock before network work.
7. From committed admission, select/reuse deterministic response intents and
   process explicit ACKs. Reopening enumerates this work from portable evidence;
   mediator redelivery and an in-memory queue are not prerequisites.

A library that cannot expose a separately authenticated envelope while deferring
`from_prior` verification cannot claim step 2 succeeded. It must keep the delivery
pending or use a separately specified durable ciphertext inbox. This candidate
neither labels unopened ciphertext authenticated nor specifies such an inbox.
Definitively invalid envelope authentication still takes the existing terminal
pre-vault path, with pickup ACK but no authenticated observation or peer effect.

Missing *continuation* evidence no longer keeps an otherwise independently
authenticated delivery on the mediator. This does not promise the missing evidence
will ever arrive. The receiver has accepted responsibility for its retained copy,
not accepted the claimed sender continuity.

### 6.2 Admission policy

Before admission, require one complete, conflict-free origin/path interpretation,
all baseline intent/header integrity checks, one-use invitation availability and
applicable local block policy. A carried invalid proof cannot be ignored to admit
the carrier as a new root. A same-DID key outside the pinned authorizations can be
authenticated and observed but cannot join the scope on that fact alone.

Evaluate superseded-peer rejection at **admission time**, under the operation
lock. This deliberately moves the baseline producer-time check from receipt to
acceptance: an old-DID input stored before a rotation but not yet admitted may
be rejected after the new peer end is accepted. A previously committed admission
retains its historic interpretation through later rotation, recovery and import.
A duplicate may only resume already eligible unfinished work; it creates no new
response obligation. Contact deletion and current local sender eligibility still
suppress new effects without reinterpreting old admissions.

Rejection or erasure is not a permission to run the input under a new origin,
handler ID or namespace. Pending input may be shown as unverified/unassigned;
that UI state must not be presented as accepted protocol input.

### 6.3 One-use invitations

In this candidate, consumption is derived from a structurally valid committed
**admission**, not from an observation. `invitationDisclosureEventId` is non-null
only for a proof-free root input at the exact disclosed local DID, with matching
`pthid == oobId`, a live eligible origin, and `uses == "one"`. Its consumer is the
derived scope. Continuation input or another recipient cannot consume by sharing
a thread ID. Check availability and commit admission under the same operation
lock; competing consumers from imports leave the invitation unavailable and
conflicted, never choose an arrival-order winner.

Unadmitted observations, contact assignment and a crash before admission consume
nothing. Consumption survives erasure, contact deletion and later input/scope
conflicts. A reusable invitation does not impose the one-use restriction.

<a id="execution"></a>

## 7. Execution identity and ACK authority

Only admitted application input can authorize continuity-scoped execution.
Conflict detection also considers complete candidate observations even if they
have not been admitted; withholding admission does not hide contradictory evidence.
For every `(scopeId, origin sender, wireMessageId)`, compare all independently
validated, complete observations. Equal intents are logical aliases; different
intents conflict even when they used different keys/channels. An unresolved
sibling cannot hide a disagreement between two complete observations. Missing
required evidence defers new work; incompatible scope/admission evidence conflicts.

Original observation IDs, evidence and committed execution IDs remain audit facts.
The candidate does not rewrite them when a graph grows. Automatic effects retain
the baseline tuple `(executionId, handlerId, effectKind, ordinal)`, deterministic
outbound-ID derivation and one ACK-bearing response per execution. Changing the
handler tuple cannot evade a carrier conflict. Admission must already be
committed when the effect validator checks that tuple and selects the response.

Contact attachment is never an ACK lookup key. An explicit `ack` applies only to
an existing outbound whose immutable target and prepared package evidence authorize
this admitted peer in the same scope and correct direction. Equal wire IDs in
another scope, another contact member or the opposite sender direction do not
match. Preserve exact outbound-package membership checks; scope equality alone
is not sufficient authority.

`please_ack` expansion, ordered targets, intent freezing and the distinction
between submission and ultimate acknowledgment remain as in
[DD ACK processing](distributed-delivery.md#durable-end-to-end-acknowledgment).
Freeze eligible targets from admitted input in original receive order; an earlier
unadmitted observation supplies no target. Later admission cannot mutate an
already selected response. No ACK is emitted merely for storage or a contact
merge. Control/Empty/Trust Ping response loops remain prohibited.

The baseline's crash contract is retained: an external effect is not made
process-level exactly-once merely by a deterministic ID. The external operation
still needs its protocol's idempotency or explicit at-least-once contract.

<a id="sending"></a>

## 8. Outbound intent and channel selection

An immutable target is one of:

```text
{ kind: "channel", channelId }
{ kind: "addresses", localDidId, presentedPeerDid }
{ kind: "scope", scopeId, localOriginDidId, canonicalPeerOriginDid }
```

An existing channel target fixes that exact authenticated endpoint context. An
address target supports first contact before online resolution: after resolution,
its first preparation pins one channel and its exact evidence. Further packages
must keep that channel; failure or a changed address/key cannot silently turn it
into a scope target. The pin survives package erasure. These targets need no
contact or origin event and can send ordinary useful content.

A scope target fixes the immutable original DID pair and scope ID at intent time,
so it can also be committed offline before a `channel.origin` witness exists.
Before preparation, resolve/pin or reuse the origin, validate rooted evidence,
then select a usable channel in that scope. Selection can follow verified address
changes while the outbound remains unsubmitted. The actual channel and exact
proof/security/route evidence belong to `message.prepared`, not to a mutable
contact preference. A package may describe a channel not previously observed.

These are different user intents. `sendToContact` must resolve a local preference
into one of these targets at intent commit, not defer a mutable contact ID to
network time. Changing the contact or preferred channel does not retarget a
queued message. Repeated `message.out` rows for one message ID must agree on
both wire intent and local target; equality of the wire `intentHash` alone does
not permit changing an excluded local target.

Continuity-scoped automatic replies always target their admitted scope. There is
no provisional channel-scoped automatic fallback while membership is pending.
An exact-channel/address outbound can receive receipt information only from the
same authenticated channel and an admitted input; it does not gain cross-channel
ACK or repack rights because the UI later groups its channel into a contact.
A client needing rotation-transparent ACKs should choose a scope target initially.

Keep vault-first intent, exact prepared-envelope retention, eligible local sender
checks, per-message serialization and the existing submission boundary. One
committed valid `delivery.submitted` ends sending work for all packages of that
logical outbound. A missing ACK, late edge or contact change cannot reopen it.

<a id="contacts"></a>

## 9. Contacts, attribution, profile claims and blocking

Contacts hold discovery hints and explicit channel attribution; an unverified DID
hint is not yet an authenticated channel. Preserve UUIDv7 IDs for explicit local
contacts. Proposed attribution events are:

```text
contact.channelAdded  { contactId, channelId }
contact.channelRemoved { contactId, addEventIds: EventReference<contact.channelAdded>[] }
```

Removal names the additions it removes, not all future attachments. Concurrent
unremoved additions remain visible. A contact may group multiple channels and
unrelated origins. Conflicting exclusive-attribution preferences are UI/policy
conflicts, not evidence that different scopes should merge. A view may display
verified successors under an existing contact, but that derived presentation does
not rewrite the explicit additions or create continuity authority.

Automatic contact creation is application policy after admission, never receipt
or a control-message requirement. An implementation retaining deterministic
automatic creation uses:

```text
autoContactId = UUIDv5(estocNamespace("scope-contact"),
  UTF8(RFC8785(["v1", scopeId])))
```

Reuse an explicit assignment instead when policy selected one. Tombstones prevent
automatic recreation. Names/profile disclosures retain their exact source
observation and admission; moving a displayed channel does not change who
asserted a name or what scope authorized it. No key-control claim is inferred
from a merged profile.

Contact grouping and protocol blocking are separate decisions. To preserve the
baseline delete-contact behavior, deletion must atomically record durable denial
selectors for the affected exact channels and each affected admitted origin,
alongside the contact tombstone. The proposed event is:

```text
interaction.blocked {
  contactId,
  targets: ({ kind: "channel", channelId } | { kind: "scope", scopeId })[]
}
```

Targets are selected and frozen under the operation lock. Equal deny selectors
are idempotent; deleting the contact or detaching its channels never removes them.
A scope selector covers later verified successors of that same origin. This
candidate has no automatic unblock; an explicit future unblock operation must
be separately specified. Grouping changes cannot create cryptographic authority,
and they cannot silently revoke an explicit deny. They may change UI visibility
and preferences. New traffic at a genuinely unrelated unknown identity cannot be
recognized as a deleted human from a contact label; no such guarantee is claimed.

<a id="recovery"></a>

## 10. Recovery, erasure, resources and import

Open/recovery enumerates observations without admission, origin/edge witnesses,
committed admissions without selected effects, and eligible unsubmitted intents.
It uses the saved authentication evidence; recovery of an already committed
observation is not a new live delivery. A genuinely new delivery still passes
current authentication. Runtime-local wait queues are caches only.

Held roots include observed content and all obtained authentication/continuation
objects needed by pending input, plus the baseline roots for unfinished intents
and packages. Evidence references, compact proofs, hashes, origin claims,
admissions, block selectors and consumed-invitation state survive content erasure.
Collection may not silently remove pending proof material or manufacture a new
origin after its claim disappears. Explicit user erasure suppresses unfinished
content-dependent responses rather than regenerating their content. An erased
observation must retain its anti-replay/membership headers. Missing imported
objects defer; arbitrary newer documents cannot repair a historical pin.

Apply hard ingress, per-source/per-recipient and retained-byte limits. Storage
failure before observation commit leaves pickup pending. An explicit terminal
resource rejection may use the existing safe terminal pickup-ACK path; a timeout
is not positive evidence of a new origin. Resource policies must not silently
discard a committed pending message after requesting mediator deletion while
continuing to promise recoverable processing of it. Discard/erase must be visible
and preserve the structural claims that prevent reclassification/re-execution.

A complete event union yields the same validated graph, admissions and conflicts
in every import order. Preserve all conflicting claims and suppress affected
new work. A partial union may be pending. It must not execute merely because the
missing part would reveal a competing claim already referenced in retained data.
No arrival-order or clock-order winner resolves authority conflicts.

The [storage event envelope](event-store.md#the-event), raw objects and
[SQLite transaction/ownership contracts](vault-sqlite.md#reading-guide) do not
need a new relationship table. Optional scope/channel projections remain
rebuildable. Adoption does require an explicit domain-profile/version discriminator
and import rejection of incompatible legacy domain events; this experimental PR
does not activate or reserve a production format marker. In particular, do not
silently reinterpret baseline `message.in` or its `v2` execution IDs as candidate
observations/admissions.

<a id="conformance"></a>

## 11. Candidate conformance cases

CG IDs are new. They do not retire or claim passage of existing VE/DD/RZ cases.
The companion [model tests](channel-graph.test.mjs) exercise identifier and
already-validated evidence-fold examples, not DIDComm cryptography, SQLite,
mediator delivery, import parsing or a production event validator.

| Case | Required result |
| --- | --- |
| CG-01 | Reverse local/peer orientation yields the same channel and origin scope IDs; opposite senders have different execution IDs. |
| CG-02 | Equal keys under unrelated canonical DIDs do not share channels or confer scope membership. |
| CG-03 | A new selected key creates a new channel; another key authorized by the same exact pinned document can share its existing scope. |
| CG-04 | Adding a valid continuation changes neither scope ID nor existing execution/effect IDs. |
| CG-05 | Contact attach/detach/merge/split leaves execution identity and proof authority unchanged. |
| CG-06 | Independently authenticated input commits without an origin, contact or complete continuation; pickup ACK follows that commit. |
| CG-07 | Missing envelope authentication cannot be relabeled an authenticated observation to obtain a pickup ACK. |
| CG-08 | Crash after observation/pickup ACK but before admission recovers from retained input without mediator redelivery. |
| CG-09 | A proof carrier's edge validates from its committed observation without requiring its own prior admission. |
| CG-10 | A proof-free successor following a known pending carrier is observed but cannot create another origin or execute provisionally. |
| CG-11 | Invalid/missing proof or wrong historical snapshot never grants membership; a newer document with a different CID is not a repair. |
| CG-12 | Duplicate equivalent edges are idempotent; conflicting successor/proof/document claims suppress work without an arrival-order winner. |
| CG-13 | A missing rooted prefix defers; adding it converges in every import permutation. |
| CG-14 | Simultaneous local/peer rotations admit the new/new channel once both paths exist, without observing the intermediate cross pairs. |
| CG-15 | Competing changes to the same endpoint or a cycle conflict; ordinary DID rotation is not parallel-device delegation. |
| CG-16 | A late edge between independently rooted scopes conflicts and does not merge their IDs or replay old effects. |
| CG-17 | One observed channel claimed by distinct origins conflicts every claimant; suppressing one cannot elect another. |
| CG-18 | Equal wire ID/intent on authorized channels yields one execution; contradictory intents conflict across channels. |
| CG-19 | An unresolved sibling cannot hide contradictory complete observations or authorize per-channel execution. |
| CG-20 | A scope/contact match alone cannot ACK an outbound: direction, exact target and prepared-package authority also match. |
| CG-21 | Raw receipt and later contact attachment emit no peer ACK. An admitted duplicate cannot select another ACK-bearing effect. |
| CG-22 | Scope/address/channel intent targets freeze offline; contact changes cannot retarget them. Exact-channel targets cannot silently repack through rotation. |
| CG-23 | Submission completes only at the existing durable boundary; late edges and missing ACKs cannot reopen it. |
| CG-24 | One-use OOB consumption occurs at qualifying root admission, not observation; imports with competing consumers remain conflicted/unavailable. |
| CG-25 | Contact deletion preserves frozen channel/scope denies and consumption; detach/reattach and successors cannot resurrect interaction. |
| CG-26 | Erasure/reopen preserves structural origin/continuation claims, admission identity and effect tombstones; no fresh-root fallback appears. |
| CG-27 | A superseded sender is rejected at new admission, while an earlier committed admission retains its historic interpretation. |
| CG-28 | Admission/effect validators reject self-authorizing batches and mixed-source observation witnesses. |
| CG-29 | A JWT at a shared public DID affects only its uniquely evidenced origin, not unrelated channels using that DID. |
| CG-30 | Incompatible baseline/candidate domain histories are not silently combined or renumbered during import. |

Run the dependency-free examples from the repository root:

```sh
node --test docs/replica-model/channel-graph.test.mjs
```

A passing example suite is not a claim of complete CG conformance. Crypto fixtures,
crash injection, storage validation and the full case matrix are adoption work.

<a id="integration"></a>

## 12. Integration and rule-ownership map

This candidate is intentionally a separate review target, not an overriding
paragraph that leaves contradictory schemas active. Adoption must edit the
owning sections below together and then move candidate rules to their owners.
Existing anchors/case identities must be retained or explicitly retired in suite
history. Neither a mechanical `relationshipId` -> `scopeId` rename nor making
binding references nullable is a complete implementation.

| Existing owner | Proposed change on adoption |
| --- | --- |
| [VE identifiers](vault-events.md#identifier-and-reference-vocabulary), [DD identities](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | Add channel/scoped-origin vocabulary and section-2 transcripts; separate channel observation groups from admitted execution. |
| [VE binding/evidence](vault-events.md#receipt-and-relationship-evidence), [binding](vault-events.md#relationship-bound), [relationship fold](vault-events.md#relationship-fold-and-address-index) | Replace the authoritative relationship aggregate with observation facts, optional origin witnesses and a rooted continuity fold. |
| [VE peer changes](vault-events.md#relationship-peertransitioned), [local changes](vault-events.md#relationship-localtransitioned), [RZ rotations](relationships.md#peer-address-changes) | Rehome exact-proof checks onto typed origin-scoped edges; preserve single-successor replacement and confirmation semantics. |
| [VE inbound](vault-events.md#message-in), [inbound fold](vault-events.md#inbound-message-and-execution-fold), [DD receipt](distributed-delivery.md#receive-a-message), [RZ receipt](relationships.md#uniform-receipt) | Split observed/admitted input, move relationship-evidence waits after authenticated storage, change superseded-sender and invitation boundaries explicitly. |
| [DD commit table](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table), [ACK](distributed-delivery.md#durable-end-to-end-acknowledgment), [effects](distributed-delivery.md#automatic-effects) | Pickup ACK after durable observation; peer ACK/effects after committed admission; no provisional application execution. |
| [VE outbound](vault-events.md#message-out), [DD preparation](distributed-delivery.md#preparing-a-package), [RZ sending](relationships.md#ordinary-sending-and-birth-selection) | Freeze exact channel/address or origin-scope target; retain vault-first/offline intent, immutable wire intent and submission completion. |
| [VE contacts](vault-events.md#contacts), [attribution](vault-events.md#relationship-contactassigned), [invitation](vault-events.md#invitation-fold) | Attribute channels independently; preserve claim provenance; use admission-based invitation consumption and explicit frozen block selectors. |
| [VE held roots](vault-events.md#held-roots), [DD recovery](distributed-delivery.md#receive-recovery), [VE procedures](vault-events.md#procedures) | Retain pending observations/proofs and new admission/block events; update erasure, delete-contact and writable-open recovery. |
| [SQLite](vault-sqlite.md#reading-guide), [event store](event-store.md#reading-guide), [DASL](dasl-objects.md#reading-guide) | Keep storage contracts; add explicit domain-profile validation and appropriate held-root traversal before format activation. |
| [Replica mediation](replica-mediation.md#reading-guide), [vault sync](vault-sync.md#reading-guide) | Remain deferred; update future receipt/import descriptions, without claiming new multi-writer execution guarantees. |

### 12.1 Review decisions and limits

This proposal chooses key-specific channels **with DID authorization context**,
immutable DID-pair origins, typed replacement edges, and durable admission rather
than a bare connected-component algorithm. It deliberately keeps a small amount
of origin/acceptance evidence: those facts prevent re-rooting and re-execution,
not an independently editable relationship object in disguise.

The main gain is the removal of long-term attribution from the storage gate.
Missing continuity can remain pending in the vault, contacts remain editable
local groupings, and channel facts do not change when interpretation develops.
The costs are retained pending-input storage and an explicit admission boundary.
Cross-origin reconciliation and parallel-device delegation remain separate future
protocol design questions; adding them is not required to evaluate this split.

Before activation, complete the owner edits above, closed payload/schema validation,
format discriminator/migration decision and the full CG integration tests. Old
persisted execution/effect IDs cannot be converted by simply rerunning the new
hash formula. This PR intentionally does not claim such a migration exists.

<a id="references"></a>

## 13. External references

- [DIDComm Messaging 2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/),
  especially DID Rotation, rotation limitations and ACKs. The candidate does not
  redefine `from_prior` as generic delegation or introduce wire scope IDs.
- [Message Pickup 3.0](https://didcomm.org/messagepickup/3.0/), especially
  `messages-received`. Clearing a mediator delivery is distinct from admitting
  its application input and acknowledging that input to the ultimate peer.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), JSON Canonicalization Scheme.
  The companion examples use only the constrained string-array/string-object
  transcripts specified here, not a general replacement for a JCS implementation.
