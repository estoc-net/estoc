# Estoc Rendezvous and Pairwise Bootstrap Profile 1.0

Status: **draft, phase 1** — a single-active-runtime processing profile for
discovery and privacy-preserving handoff from a vault-scoped
rendezvous DID to a contact-scoped `did:peer:4` relationship. Multi-replica
mediation and vault synchronization are deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

This profile does **not** define an Estoc DIDComm protocol family. In
particular, there are no messages named:

```text
https://estoc.dev/rendezvous/1.0/request
https://estoc.dev/rendezvous/1.0/accept
https://estoc.dev/rendezvous/1.0/decline
```

Bootstrap uses ordinary DIDComm application messages. A party with no other
application message to send uses Trust Ping 2.0. A local Estoc responder hands
the relationship from its rendezvous DID to its own pairwise DID with standard
DIDComm `from_prior`. A remote peer may instead continue using its original
public or rendezvous DID; pairwise generation is a local privacy policy, not
a condition for accepting authenticated replies.

## 1. What it is for

The DID used to discover a vault need not remain the DID used inside an
ongoing relationship. Estoc separates:

- a **rendezvous DID**, disclosed so an unknown party can send an initial
  encrypted DIDComm message; and
- a **relationship DID**, a pairwise `did:peer:4` used for the resulting relationship.

The locally controlled rendezvous path is a self-resolving long-form
`did:peer:4`. It can be shared by QR code, OOB URL, file, NFC, local exchange
or another invitation transport without a domain or online DID resolver.
DID-document publication is outside the vault's responsibilities. Resolution
of externally managed DIDs remains subject to section 5.1.

The flow when both parties use the local Estoc policy is:

```text
Alice discloses rendezvous DID R_A
                 │
                 │ Bob sends ordinary initial message X
                 │ from pairwise DID P_B to R_A
                 ▼
        Alice validates and commits X
                 │
                 │ durable receipt
                 ▼
Alice sends the first response Y from P_A
with from_prior proving R_A -> P_A
                 │
                 ▼
P_A <--------------------------------------> P_B
             later relationship traffic
```

The initial message may already be useful application content. The protocol
does not require a separate connection request before that content.

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
- `vault-events.md`.

Phase 1 uses ordinary Coordinate Mediation and account-scoped Message Pickup
when a mediator is used. `replica-mediation/1.0` and `vault-sync/1.0` are
informative deferred extensions, not dependencies of this profile.

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

## 3. Terms

- **Rendezvous DID** — a bootstrap discovery DID. A locally controlled one is
  a vault-scoped `did:peer:4` entity with role `rendezvous`; an external target
  is represented by resolution evidence, not a local DID entity.
- **Peer rendezvous DID** — the self-resolving `did:peer:4` rendezvous profile.
- **Relationship DID** — a vault-scoped pairwise `did:peer:4` created for one
  relationship.
- **Initial message / initial attempt** — an application message selected for
  bootstrap or a later bootstrap attempt under section 8. A local initiator
  records that selection in its outbound intent; a remote initiator may use
  any supported authenticated DID under section 5.1.
- **Bootstrap candidate** — an authenticated message addressed to a
  local rendezvous DID, committed after the receive and integrity checks,
  with neither a carried `fromPrior` nor a `peerTransition` reference under
  `vault-events.md` section 12.1. Peer continuation uses the existing
  relationship even when delivered to this same address.
  Its durable receipt supplies relationship scope; only an application
  candidate authorizes automatic materialization under section 10.
- **Application candidate** — a bootstrap candidate that is neither a
  control observation under `vault-events.md` section 14.7 nor of type
  `https://didcomm.org/empty/1.0/empty`,
  `https://didcomm.org/trust-ping/2.0/ping-response` or
  `https://didcomm.org/report-problem/2.0/problem-report`, whether or not the
  input satisfies the control predicate. Only an application candidate selects
  a handoff response or materializes a relationship under section 10; every
  other candidate is control or non-handoff input.
- **Deterministic protocol response** — an automatic response whose complete
  portable intent follows the triggering inbound and committed protocol state.
  Committed intent is always reused.

- **Handoff response** — the first responder message for the relationship. It
  is a deterministic protocol response, a Trust Ping `ping-response`, or an
  Empty Message ACK, sent from the responder relationship DID with
  `from_prior`. Human-authored content is never the handoff response.
- **Handoff confirmation** — an authenticated message received at the new
  responder relationship DID. A conforming initiator also explicitly ACKs the
  handoff response.
- **Initial-message-bound resolution snapshot** — retained exact DID document
  bytes under their raw CID and selected key IDs used to address one initial
  message. It binds an ordinary application message, not a custom rendezvous
  protocol request.
- **Bootstrap channel** — the authenticated channel from the initiator
  relationship key to the responder rendezvous key.
- **Relationship ID** — the deterministic ID both ends derive for
  `(rendezvous DID, authenticated initiator public key)`.
- **Full runtime** — the active writable incarnation of the vault. It may run
  locally or on a server. Phase 1 has exactly one active full runtime.

## 4. Invariants

1. The initiator and responder address DIDs, never replica IDs.
2. The initial message is an ordinary DIDComm message. Trust Ping 2.0 is the
   universally supported no-content default.
3. There is no Estoc wire-level `accept` or `decline` message.
4. Every valid bootstrap passing the receive and integrity checks is
   accepted at its `message.in` commit, without an admission policy or decision.
5. A durable application bootstrap creates or reuses one deterministic
   relationship, contact and responder pairwise DID. Control input does not
   by itself materialize them or select a handoff response.
6. A locally materialized responder relationship has one frozen initial
   `from_prior` proof and rotation instant. A remote peer need not rotate.
7. Before handoff confirmation, `from_prior.sub`, plaintext `from`, protected
   `skid` and decoded `apu` use the same responder Peer-DID long form.
8. The initial handoff's `from_prior.iss` and its protected `kid` use the exact
   rendezvous-DID spelling pinned by the relationship origin; the `kid` belongs to that exact
   `iss`. Later local rotations use their own predecessor under
   `vault-events.md` section 12.4.
9. The transition names its relationship and matching contact. It does not
   globally retire or alias the rendezvous DID.
10. Repeated initial messages from the same authenticated initiator key to the
    same rendezvous DID reuse the same relationship.
11. Each initial message remains a separate application message and may have
    its own deterministic protocol response and thread.
12. A deterministic contact tombstone is not resurrected by another initial
    message from the same initiator key.
13. Ordinary `writeTo` never uses a local rendezvous DID as sender. The
    peer's current pinned or verified DID may be its original rendezvous or
    public DID, subject to section 8's qualifying inbound rule.
14. A mediator treats rendezvous and relationship DIDs as ordinary recipient
    DIDs and stores only encrypted inner envelopes.
15. Phase 1 has one active full runtime. The deferred replica profiles MUST NOT
    be required to implement this bootstrap.

## 5. DID profiles and resolution evidence

### 5.1 Common requirements

A locally controlled rendezvous DID MUST:

- be represented by `did.created` with role `rendezvous`;
- contain its one fixed key-agreement method for new initial messages;
- contain its one fixed authentication method capable of signing `from_prior`;
- bind one DIDComm delivery route through `boundRoute`;
- use seed-derived key names represented by the vault; and
- to receive new input, be non-retired and pass the DID/route checks in
  `vault-events.md` section 14.3.

Before the first package is submitted, the initiator MUST durably retain:

- the exact presented rendezvous DID;
- the canonical rendezvous DID;
- the exact RFC 8785 canonical resolved DID document under its raw DASL CID;
- the selected authentication `kid`;
- the selected key-agreement `kid`; and
- the resolution event ID.

This is the initial-message-bound resolution snapshot used later to verify
`from_prior`. A current resolver result MUST NOT silently replace it. A later
resolution may recover missing bytes only when the raw CID of its canonical
document bytes equals the pinned document CID.

An external peer or mediator may use `did:web`; resolving it does not create a
locally controlled DID entity or a document-publication obligation. A Web
resolver used by a mediator or client MUST be constrained against SSRF, DNS
rebinding, redirects to forbidden networks, unbounded responses and DID
mismatch. Failure to resolve safely is deferred or reported as
`did-resolution-unavailable` only for the transient failures classified below.
A policy-forbidden fetch is a definitive failure; no failure falls back to an
unrestricted fetch.

For an external Web rendezvous target, the initiator pins the exact Web
document revision before first submission and later verifies `from_prior`
against that snapshot even when the currently published document has changed.
Key IDs are taken from that exact authorized document, not synthesized from a
vault key-generation naming convention.

Remote initiators and responders may use either a public DID, including
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

This section owns recipient-resolution freshness. A `did:peer:4` recipient
uses its retained, validated long-form document and needs no fresh resolution.
For every other supported DID method, the preparer MUST resolve after the
new outbound intent commits and commit that fresh `peer.resolved` before its
first package. Do this for each new MID, including later initial attempts;
an earlier outbound's snapshot, a local TTL or a resolver's stale/offline cache
cannot satisfy the requirement. An online conditional revalidation that
confirms the same document is sufficient and produces a new resolution event.
If no first package committed before interruption, repeat resolution on resume.
Unavailable resolution keeps the outbound retryable; it is not evidence of a
key change. Freshness is a producer ordering rule, not a clock comparison in
the portable fold.

Once a package exists, retry does not re-resolve and uses its exact bytes.
Permitted repacking of that MID reuses its retained snapshot, or the exact
carrying-inbound snapshot of a committed verified continuation to a new peer
end; it never obtains a fresh document merely to replace a pinned key or route.
An initial MID retains its first snapshot and key on every package.
First-package resolution uses the failure classification below, including
the outbound `peer-key-changed` result. A fresh resolution remains evidence for
current preparation, never authority to extend a relationship's chain.

This section also owns sender-authentication freshness. A `did:peer:4` sender
authenticates against its validated long-form document, retained or supplied
with this disclosure. For every other supported method, the receiver MUST
resolve the presented sender DID for each delivery and authenticate its
authcrypt key against that current document. Online conditional revalidation
is sufficient; a local TTL or stale/offline cache is not. A retained
`peer.resolved` may be reused only when that freshly validated document's raw
CID equals its `document` and its `myKey`, `peerKey`, `did` and `presentedDid`
match the observation; otherwise commit new evidence before `message.in`.
A key absent from the current document fails section 9.2 even when it belongs
to `peerChain(R)`: the chain scopes already authenticated observations, it does
not authenticate new ones. Unavailable resolution defers without pickup ACK
only within the budget below; it cannot fall back to a stale snapshot.

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
or binding, including for a first initial attempt; unavailable answers keep
the outbound retryable. Missing retained historical evidence still follows
the separate recovery rule and is not a definitive new-resolution result.
Other completed unsuccessful resolution results are definitive for that
attempt; a policy refusal MUST NOT be disguised as transient unavailability.

The `peer-key-changed` code also covers definitive first-package resolution
failure when no earlier peer key exists. User-facing text MUST NOT describe
every such result as an observed key replacement; use the bounded local
resolution diagnostic, or a neutral peer-resolution failure label when that
diagnostic is absent. This does not add a portable diagnostic payload.

**Inbound sender-resolution budget.** Once local receive prerequisites are
satisfied, the runtime MUST use finite per-attempt timeouts, a finite attempt
budget and local backoff with a finite cap for each delivery. It SHOULD use
section 14's retry-interval, backoff-cap and attempt-count defaults, applied
to resolution calls rather than transport submissions; the outbound wire
expiry rule does not apply. Count an attempt before invoking the resolver,
including failure and unknown outcomes. While receive-ready, schedule retries
without waiting for another delivery or an external resolution-change signal.
Cap the wait at any known mediator delivery-retention deadline; when only a
retention duration is advertised, use it as an upper bound on this resolution
wait. Unknown retention never permits an unlimited budget.

All workers share accounting for the same local mediation and pickup-delivery
attachment ID; a profile with replica-scoped pickup also includes that replica
ID. Direct input uses its normalized envelope CID in the local receive context.
Redelivery and reconnect MUST NOT reset this accounting or start parallel
budgets. The accounting is local scheduling state, not a portable event;
runtime restart, restore or loss of local state may reset it as in section 14.

When the budget or retention stop is reached without a definitive answer,
classify that delivery as terminal input under section 9.2: pickup-ACK when
mediated, no `message.in`, contact or response effect, and at most a bounded
local diagnostic. Exhaustion does not prove a key change or permanently reject
the DID; the sender may make a new explicit attempt under ordinary sending
rules. It never authorizes automatic retry of a submitted MID. A successful
resolution within budget instead proceeds through normal authentication and
durable receipt. Locked-vault, incomplete-recovery and recoverable local
key/route/historical-evidence deferrals under section 9.1 have no such budget:
do not run this accounting or apply its terminal path while those prerequisites
remain unresolved. This bounds an unresolved authentication attempt, not the
age, expiry or acceptance time of a valid initial message.

These rules also apply to duplicate deliveries that would create a new
observation. If interruption occurs before inbound commit, resolve again on
resume, even if resolution evidence already committed. Recovery or import of
an already committed observation verifies its retained evidence without a new
network resolution; a later revocation does not invalidate historical receipt
or scope. As with recipient freshness, this is a producer ordering rule, not
an event-time or fold-clock test. Historical `from_prior` verification still
uses its pinned predecessor snapshot independently of current sender
authentication.

A key change under the same canonical peer DID without verified continuation
is not continuation of an existing relationship. Phase 1 uses the following
policy; a fresh `peer.resolved` never extends `peerChain(R)`:

- For a new package to an existing relationship's peer DID, including a later
  initial attempt, select an authorized key already in `peerChain(R)` under
  `distributed-delivery.md` section 9, with the canonical DID and key matching
  the same pinned or verified transition snapshot. If a successful fresh
  resolution offers no usable key with that evidence, or resolution fails
  definitively under the classification above, append message-scoped terminal
  `delivery.failed(code="peer-key-changed", packageId=null)` before preparation
  or channel attachment. Do not append an incompatible package or binding and
  do not mark the whole relationship conflicted. Resolution unavailability
  remains retryable. An already pinned initial package continues to use its
  exact retained snapshot; it does not re-resolve to replace its key.
- For an authenticated inbound addressed to `R`'s local relationship DID,
  or a recognized successor at its original rendezvous recipient,
  whose canonical sender DID is evidenced in `R` but whose key is outside
  `peerChain(R)` and which carries no `from_prior`, preserve the observation
  and exact resolution evidence but derive no execution scope. Process no ACK
  or effect. Surface a `peer-key-changed` diagnostic under
  `vault-events.md` section 14.6 instead of silently waiting for more evidence.
  Missing binding/chain evidence remains ordinary deferral; an invalid carried
  proof follows the existing conflict rule, not this no-proof path.
- To restart without a valid peer rotation to a different DID, use an explicit
  new initial attempt with a fresh local relationship DID/key, producing a new
  relationship and binding. Do not rewrite the old binding or replay its messages.
  A new bootstrap candidate at a local rendezvous DID still follows its
  key-derived relationship and receive procedure. A carried or already
  committed continuation follows section 12 instead; repeating the sender
  DID alone cannot replace the required authorization evidence.

Missing historical snapshot material is a deferred verification state, not
proof that a handoff is invalid.

### 5.2 Peer DID numalgo-4 profile

Every locally controlled rendezvous or relationship DID uses Peer DID numalgo
4. A vault stores both validated long form and canonical short form as
spellings of one DID entity under `vault-events.md` section 5.2.

For a Peer rendezvous DID:

- the OOB invitation or other first disclosure MUST provide the long form;
- the initiator resolves it locally and validates its encoded input document;
- the canonical short form is used in initial-message plaintext `to`, Routing
  `forward.next` and mediator recipient registration;
- the exact presented long form is retained in the initial-message-bound
  snapshot and later used as `from_prior.iss`;
- the `from_prior` protected `kid` is that exact `iss` plus an authentication
  fragment authorized by the pinned document; and
- the bound ingress route and fixed keys MUST equal the rendezvous long-form
  input document.

The route embedded in the responder relationship DID is independent of the
rendezvous ingress route. It MAY use another mediation arrangement to reduce
mediator-side linkability.

For an initiator or responder relationship DID, the long form MUST be used on
first disclosure. Every locally produced initial attempt uses its sender's
long form, including later attempts, so whichever candidate becomes the peer's
origin pins the same predecessor spelling. Until each local handoff or rotation
is confirmed, every package from its successor uses the long form and frozen
proof under `vault-events.md` sections 12.2 and 12.4. Confirmed ordinary traffic
normally uses the canonical short form; later short-form traffic never replaces
the pinned predecessor spelling for proof verification.

For every authcrypted package whose sender is a Peer DID:

1. plaintext `from` is `S`;
2. protected `skid`, when present, is a DID URL whose DID portion is
   byte-for-byte equal to `S`;
3. decoded protected `apu` is the exact UTF-8 `skid` string;
4. when the library represents the sender key only through `apu`, its DID
   portion is still byte-for-byte equal to `S`; and
5. the key fragment resolves to a key-agreement method in the document for
   that exact DID representation.

On first disclosure, plaintext `from`, the DID portion of `skid`, and decoded
`apu` all use the same long form. A package MUST NOT mix long and short forms.
A short form received before its long-form input document is known is
terminal input failing section 9.2's first-disclosure check; it cannot
authenticate a new relationship.

## 6. Out-of-band discovery

A reusable invitation contains a rendezvous DID, not a relationship DID.

Example:

```json
{
  "type": "https://didcomm.org/out-of-band/2.0/invitation",
  "id": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "from": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
  "body": {
    "goal_code": "establish-relationship",
    "goal": "Start a private pairwise relationship",
    "accept": ["didcomm/v2"]
  }
}
```

The invitation ID is the `pthid` of the initial interaction. One reusable
invitation may start many independent protocol threads. A one-use invitation
is permanently consumed at the candidate `message.in` commit under
`vault-events.md` section 14.9, independently of later contact attachment or
handoff materialization. Detach, contact deletion and erasure do not reopen it;
retries for the same consumer reuse that relationship rather than creating
another take.

An invitation may include one or more alternative protocol-message
attachments. The recipient chooses at most one supported alternative and acts
on it according to that protocol. The recipient's first outbound message in
that child interaction is the initial message defined by this profile and uses
the invitation ID as `pthid`. When the invitation supplies no usable child
protocol message, or the selected protocol has no initial outbound for the
recipient, the initiator uses Trust Ping 2.0 by default.

Relationship DIDs MUST NOT appear in reusable invitation plaintext or public
discovery material.

## 7. Rendezvous DID lifecycle

A rendezvous DID uses ordinary `did.created`, `did.disclosed` and `did.retired`
events under `vault-events.md` section 5. Its immutable entity supplies the
Peer long form, fixed authentication and key-agreement methods, and ingress
`boundRoute`. No separate rendezvous configuration event is required.

Every implementation supports Trust Ping 2.0 `ping` and receives otherwise
valid application types, including ones with no local handler. An unknown
application type can be stored and displayed without executing unsupported
semantics. There is no initial-specific size or lifetime restriction and no
user-approval step. Common syntax, authentication, integrity and operational
resource checks still apply under section 9.

A live rendezvous DID can receive new input when its identity and route
dependencies validate and a mediated bound route is reconciled under
`vault-events.md` section 14.3. A concrete recoverable prerequisite defers
delivery under section 9.1. `did.retired` stops new input at its commit; already
committed application candidates can finish materialization using retained
proof keys and a live pairwise route under `vault-events.md` section 5.5.

The responder selects its pairwise route when creating the relationship DID
under `vault-events.md` section 16.3. It MAY differ from the rendezvous ingress
route and is frozen in that DID's `boundRoute`. Later preference changes do
not rewrite an existing DID or its relationship origin.

## 8. Initial message profile

This section owns outbound initial-attempt classification. A `message.out` is
an **initial attempt** exactly when its immutable `initial` field is non-null
under `vault-events.md` section 9.2. It freezes the selected local relationship
DID and exact presented peer DID before any network work. The classification
does not depend on OOB discovery, `pthid`, message type, a later reply, current
resolver results or event arrival order. A replacement is a new initial intent
with a new MID. An explicit later bootstrap attempt to the original peer DID
also records `initial`, even when a relationship already exists.

Once that initiator relationship has a committed local rotation under
`vault-events.md` section 12.4, further sends in it are ordinary traffic to
its pinned or verified current peer end, including the original public or
rendezvous DID. The successor continues the existing binding with that
section's proof, not a new initial intent or a new key-derived relationship.
Pending initial intents pinned to a superseded local key follow that section's
terminal-failure rule.

Before committing a new ordinary send through an initiator relationship, the
writer MUST have a committed authenticated inbound in that relationship's
unique, conflict-free execution scope, other than a no-handoff rejection
under `vault-events.md` section 14.7. A direct application reply or pure ACK
qualifies without rotation; a handoff or later rotation validated under
section 12 also qualifies. Binding or submission alone does not qualify.
Until that evidence exists, every send to the pinned initial peer DID uses
this initial profile. A first send to a disclosed peer with no binding also
uses this profile. Without qualifying inbound evidence, an explicit-channel
send through that initiator relationship is rejected before intent commit;
the runtime does not rewrite it to a contact target.
Responder traffic authorized by durable bootstrap receipt follows sections 10–11.

Validate `initial` and all locally checkable section-8.1 constraints before
`message.out` commits. Reject an invalid request without creating an outbound;
do not add or alter headers later. Under one writer-lock operation, classify
the send, check the committed evidence and commit the intent. Later inbound
evidence never changes a committed initial attempt into an ordinary message.
Every package of an initial attempt MUST use its frozen local DID and the
canonical peer DID derived from `initial.peerDid`, with resolution evidence
whose `presentedDid` equals that exact frozen spelling. The first package pins
its exact snapshot and recipient key for all retries of that MID.

Recovery enumerates retained `message.out.initial != null` and their valid
prepared packages, then restores missing bindings under `vault-events.md`
section 12.3. It requires neither an inbound response nor a surviving OOB
invitation, body or envelope. Unprepared initial intents resume the same
preparation procedure; no ordinary outbound is guessed to be initial. Imports
validate the frozen fields and package/reference joins from the event union,
not an inferred historical before/after order.

### 8.1 Common requirements

A conforming Estoc initial message MUST:

- be authcrypted from its frozen local relationship DID;
- be addressed to the canonical DID derived from frozen `initial.peerDid`;
- use the initiator Peer DID long form on every attempt for plaintext `from`
  and the DID portion of protected `skid`, with exact decoded `apu` consistency;
- include immutable `created_time` and use the common nullable `expiresTime`
  rules in `vault-events.md` section 9.2;
- request explicit acknowledgment of the current message with
  `please_ack: [""]` or with its own wire ID;
- include the invitation ID as `pthid` when it arose from OOB discovery; and
- be durably represented by `message.out` before registration, resolution,
  encryption or network submission.

There is no initial-specific type list, byte ceiling, positive finite-lifetime
requirement or acceptance deadline. The finite expiry in the examples is an
optional sender choice; null expiry is also valid. The sender's frozen expiry
still stops unsubmitted work under `distributed-delivery.md` section 7.

A recipient preserves the exact standard `please_ack` array. `[]` requests no
explicit message ID. Missing a current-message receipt request does not prevent
receipt or relationship materialization. A receipt request does not change
the sender's submission completion rule.

A remote initial sender need not use our pairwise generation or timestamp
convention. The receiver applies section 5.1's supported-DID and authentication
rules; numalgo-4 long form is required only when that method is used. Absent
timestamps normalize to null. Initial receipt and later materialization do
not compare `created_time` or `expires_time` with the receiver's clock, even
when expiry is already past. This does not bypass malformed-header checks.

### 8.2 Default Trust Ping

When the initiator has no application message to send, it uses:

```json
{
  "id": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "type": "https://didcomm.org/trust-ping/2.0/ping",
  "from": "did:peer:4zQm...bob-short:z...bob-input-document",
  "to": ["did:peer:4zQm...alice-rendezvous-short"],
  "created_time": 1788442800,
  "expires_time": 1789047600,
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "please_ack": [""],
  "body": {
    "response_requested": true
  }
}
```

Trust Ping defines absent `response_requested` as true. The default Estoc
writer emits `true` explicitly. A syntactically valid `false` value is received
but cannot select `ping-response`; its deterministic handoff uses Empty
Message. It includes an ACK only for eligible requested targets under section
11.2; a remote sender need not have requested the current message.

A successful Trust Ping demonstrates channel reachability and message-level
security; it does not by itself grant application authorization, social trust
or account privileges.

### 8.3 Content-first bootstrap

A normal application message may replace Trust Ping. For example:

```json
{
  "id": "019b4d13-29d3-79f1-9af6-4c3f11d52ce6",
  "type": "https://didcomm.org/basicmessage/2.0/message",
  "from": "did:peer:4zQm...bob-short:z...bob-input-document",
  "to": ["did:peer:4zQm...alice-rendezvous-short"],
  "created_time": 1788442800,
  "expires_time": 1789047600,
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "please_ack": [""],
  "body": {
    "content": "Hello"
  }
}
```

The application content is the initial protocol message. It MUST NOT be
wrapped in an Estoc rendezvous protocol message. The same application content
and transport resource rules apply as for later messages.

### 8.4 Initiator preparation order

The initiator:

1. creates a fresh pairwise relationship DID `P_B` for this relationship, or
   reuses its root DID for another initial attempt in the same already bound
   relationship before any local rotation under `vault-events.md` section
   12.4. It MUST NOT select a DID belonging to another relationship;
2. selects or creates the local contact and associates the disclosed
   rendezvous DID with it;
3. prepares body and attachment objects;
4. validates section 8.1 and uses `Vault.commit` for those objects and
   `message.out`, freezing `initial` for the Trust Ping or application message;
5. reconciles recipient registration for `P_B` on its bound route when
   mediated, so the response is reachable;
6. resolves the rendezvous DID and uses `Vault.commit` for the snapshot objects
   and exact `peer.resolved` evidence;
7. validates the selected key under section 5.1, then attaches the bootstrap
   channel with `because == "rendezvous"`;
8. uses `Vault.commit` for one exact envelope and its `message.prepared`;
9. commits or reuses `relationship.initiatorBound` from that committed package
   under `vault-events.md` section 12.3; and
10. submits it directly or through Routing 2.0.

Steps 3–4 happen with networking disabled. Registration and resolution are
retryable effects. Phase 1 has one active runtime; another runtime MUST NOT
concurrently use the same local author.

### 8.5 Send an initial message

1. learn a rendezvous DID through OOB, QR, directory, file or manual input;
2. create/select a contact and append `contact.peerDidAdded` for that DID;
3. create a fresh local relationship `did:peer:4`, or reuse the same bound,
   unrotated relationship's root under section 8.4; retain both forms and
   associate it with the contact;
4. select a first application message; when no application content exists,
   use Trust Ping 2.0 `ping` with `response_requested == true`;
5. validate section 8.1 and use `Vault.commit` for body/attachments and
   `message.out` with `initial` naming that local DID and exact disclosed peer
   DID, nullable expiry, `pleaseAck == [""]`, OOB invitation ID as `pthid` when
   applicable, and `intentHash`; this may happen offline;
6. after intent exists, register the initiator relationship DID canonical
   short form on its bound route when mediated;
7. resolve the rendezvous DID and use `Vault.commit` for the snapshot objects
   and exact `peer.resolved` evidence;
8. validate the selected key under section 5.1, then append `contact.attached`
   for the bootstrap channel with `because == "rendezvous"`;
9. prepare and commit the exact package using initiator Peer DID long form in
   plaintext `from`, protected `skid` and decoded `apu`;
10. commit or reuse the initial-package binding under `vault-events.md` section
    12.3 before network submission; and
11. submit against the pinned snapshot and recipient key with bounded retry
    only while unsubmitted and permitted by expiry and the rendezvous
    retry ceiling. A committed `delivery.submitted` completes this MID.

The first message is the real Trust Ping or application message, not a custom
rendezvous wrapper. `pleaseAck == []` is legal DIDComm but requests nothing and
is not used by the conforming phase-1 writer for bootstrap.

If an unsubmitted initial message reaches expiry before preparation or retry,
append message-scoped terminal `delivery.failed(code="expired")` and submit
nothing. A replacement initial message uses a new wire ID and may reuse the
same bound, unrotated relationship's root key under section 8.4. A deleted
contact or section 5.1's same-DID key-change recovery requires a fresh local
DID/key. After local rotation, section 8 forbids another initial in that `R`.

After binding, the pinned peer DID is the relationship's initial current end.
Before qualifying inbound evidence under section 8, sends to it remain initial
attempts. After that evidence it may enter ordinary `writeTo` under
`vault-events.md` section 14.6 without a handoff. This local binding is not
evidence of remote receipt or business acceptance.

## 9. Responder receipt

### 9.1 Deferred delivery

A mailbox delivery remains pending, with no pickup ACK and no `message.in`,
only when recipient ownership cannot yet be safely classified or an exact
known local receive key has a concrete recoverable receive prerequisite:

- the vault is locked, recovery is incomplete, or the local key index is not
  yet authoritative;
- a recipient `kid` maps to an exact known local **key-agreement** method, but
  required key/document/route state is temporarily unavailable or route
  reconciliation is pending;
- required historical evidence for that exact known method is temporarily
  unavailable; or
- current sender resolution is transiently unavailable under section 5.1 for an
  otherwise eligible local recipient and its per-delivery budget is not
  exhausted. Exhaustion uses section 9.2's terminal path; the other deferrals
  in this list have no sender-resolution budget.

Once local key state is authoritative, the implementation MUST compare the
complete recipient `kid`, including DID and method fragment/purpose. A foreign
DID, a locally controlled DID with a nonexistent fragment, an authentication
fragment used where key agreement is required, a retired rendezvous DID, any
DID with a terminal bound-route dependency, or a recipient set containing no
eligible local key-agreement method is not deferred. It is terminal
wrong-recipient input. Retirement of a relationship DID alone is not terminal
for receipt; section 9.2 applies.

A phase-1 runtime retries local-prerequisite deferrals after its local state
changes. Sender-resolution deferrals follow section 5.1's scheduled bounded
retry and terminal-exhaustion rules. A future sync-enabled runtime may sync
and refold first. It MUST NOT treat a locked vault or incomplete recovery as
proof that the recipient is foreign.

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. An exact local key-agreement method is eligible
for receipt when its DID/key mapping is valid and conflict-free, its bound
route has no terminal dependency, and its DID is either a non-retired
rendezvous DID or a relationship DID, including a retired one. Missing
recoverable prerequisites defer under section 9.1. If no recipient `kid`
identifies an eligible or recoverably pending method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

Input to an eligible retired relationship key MUST pass through ordinary
decryption, authentication and durable receipt. It does not require renewed
recipient registration. Scope derivation is unchanged; current tombstones and
the availability of a usable local sender under `distributed-delivery.md`
section 8.1 still govern subsequent work. Its mediation stays in the required
receiving set under `vault-events.md` section 14.2 while its bound route
remains configured, non-retired and conflict-free and the mediation is usable.
Contact tombstones still apply under that document's section 16.6.

For an exact local recipient that can be decrypted, the responder then checks
only conditions needed to classify the input safely before writing portable
application state:

- recipient eligibility above, exact key-agreement method and valid bound route;
- valid DIDComm syntax and authenticated encryption;
- a supported authenticated sender DID under section 5.1, with matching
  `from`/`skid`/`apu` and valid first-disclosure long form for numalgo 4;
- per-source and per-rendezvous abuse rate limits; and
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
retired rendezvous DID, a definitively unresolvable sender DID, exhaustion of
section 5.1's sender-resolution budget and hard abuse/resource limits are
examples of this gate.

### 9.3 Integrity checks and durable receipt

After section 9.2, distinguish bootstrap candidates from peer continuation
under `vault-events.md` section 12.1 before running key-derived candidate
checks. Carried `fromPrior` is retained for section 12's verification. For
proof-free input from a recognized successor at this relationship's original
rendezvous, freeze the committed transition reference as `peerTransition`
under that document's section 10.2. The receive lock covers that selection
and inbound commit. Missing or conflicting relevant binding evidence defers
proof-free classification; it cannot become a new initial instead.
Continuation input uses ordinary durable receipt, with no candidate
materialization or one-use invitation consumption, even when `pthid` names
the original invitation. It never bypasses recipient or sender authentication,
contact lifecycle or proof checks. Transition and scope validation follow
section 12 before ACK processing or automatic effects.

Every bootstrap candidate passing section 9.2 proceeds automatically. Under
the vault writer lock, before committing a new `message.in`, check deterministic contact
tombstones, sender-DID consistency, recipient DID/route validity and one-use
invitation availability under `vault-events.md` sections 12.1, 14.4 and 14.9.
The checks and inbound commit are one serialized operation; network resolution
is completed before taking that lock. Commit or reuse the exact `peer.resolved`
and document first, then put its returned event ID in the separate inbound
commit while retaining the lock. A failure between those commits may leave
resolution evidence but consumes no invitation. Missing recoverable evidence
defers.

A new attempt failing a known integrity check is terminal input: pickup-ACK it
when mediated, create no `message.in`, contact, relationship or response, and
keep at most a bounded local diagnostic. Recheck recipient liveness under the
lock for duplicates too: rendezvous retirement stops any new receipt
observation. While receipt remains live, a known duplicate is recognized by
its exact consistent inbound evidence before the new-attempt integrity checks;
it may record another
observation but cannot recreate a deleted contact or resume forbidden effects.
A contradictory duplicate is an integrity failure.

The successful candidate `message.in` commit and its exact resolution evidence
are the durable receipt boundary. They consume a matching one-use invitation and
permit deterministic relationship-scope derivation, even before contact or
handoff materialization. No separate admission event, pending approval or
policy rejection exists. Only after that commit may the runtime ACK pickup
and derive a response intent in a separate `Vault.commit`.

Recovery enumerates committed candidates and finishes application candidate
materialization and eligible deterministic work under section 10, without
rechecking message age or introducing a new decision. Current tombstones,
lifecycle restrictions and integrity conflicts still suppress new work.
Retirement of the rendezvous DID or ingress
route alone does not cancel a committed candidate under `vault-events.md`
section 5.5. Retained content follows the ordinary erasure rules; there is no
rejected-candidate content queue.

## 10. Deterministic relationship materialization

Durable bootstrap receipt derives stable IDs from the canonical rendezvous DID
and authenticated initiator key, not from the initial message wire ID or type.
This is the initial binding's derivation. A carried or retained continuation
uses the original relationship under section 12, including at its original
rendezvous address; it does not rerun this formula with the successor's key.
`authenticated_peer_key` is the complete canonical public-key value defined
by `vault-events.md` section 4.1; the initiator derives it from the public key
of its own `did/<ourDid>/key-agreement`, the key its authcrypt `skid` names
and the responder derives through `message.in.peerResolution`. The
authentication signing key is not an input to this derivation.

```text
relationship_id = UUIDv5(
  estocNamespace("rendezvous-relationship"),
  RFC8785(["v1", canonical_rendezvous_did, authenticated_peer_key])
)

contact_id = UUIDv5(
  estocNamespace("rendezvous-contact"),
  RFC8785(["v1", relationship_id])
)

our_relationship_did_id = UUIDv5(
  estocNamespace("rendezvous-local-did"),
  RFC8785(["v1", relationship_id, "ours"])
)
```

The executable phase-1 vector uses canonical rendezvous DID:

```text
did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd
```

and peer key `z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis`.
The fixture key is an X25519 key-agreement key, producing:

```text
relationship_id        = 9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3
contact_id             = 5015e216-bc69-52d8-a7e1-c5c3c9a01254
our_relationship_did_id = adf87d8c-d357-5f96-bbae-f60fe5f18d58
```

The responder pairwise key names are derived from
`our_relationship_did_id`. The relationship DID's input document encodes the
route selected at its creation under `vault-events.md` section 16.3, which
may differ from the rendezvous ingress route. That committed DID's `boundRoute`
is reused after a crash, even if materialization is only partially complete.

Only an application candidate as defined in section 3 selects a handoff response
or materializes a relationship. A control observation under `vault-events.md` section 14.7
retains its derived scope and processes explicit `ack` under
`distributed-delivery.md` section 8.3, but selects no handoff, origin, contact
or local DID. An eligible ACK request uses that document's generic pure-ACK
profile subject to `distributed-delivery.md` section 8.1's common local-sender
gate; the input alone cannot create a relationship DID. No-handoff errors
retain their no-response rule. Lifecycle and integrity restrictions still apply.

An Empty, `ping-response` or Report Problem that fails the control predicate
is not promoted to an application bootstrap trigger. It never selects a
handoff. Without existing contact attribution it appears in no contact thread;
an implementation MAY surface it as unattributed input. Existing validated
attribution and protocol display rules still apply; type alone does not hide
an invalid control message.
In particular, receiving an Empty never selects another handoff Empty;
a permitted generic receipt ACK has `pleaseAck == null` and cannot continue
the handoff/ACK loop. These exclusions apply again during recovery.

The first durable application candidate selected for materialization becomes
the origin in the phase-1 single-writer profile. `relationship.established`
records that origin, exact sender `originResolution`, contact, local DID, peer, handoff
outbound and compact `fromPrior`, under `vault-events.md` section 12.2. The
origin input's `myKey` identifies the rendezvous DID; responder forms and route
come from its pairwise DID entity. Proof claims come from the verified JWT;
the execution ID and effect key come from the handoff intent.

Once frozen, later initial messages reuse the same relationship material.
They reply from its current local end under `vault-events.md` section 12.4,
using that end's required proof; they never recreate the root DID or replace
the initial proof. With no later local transition, section 11's original
handoff/confirmation rules continue to apply.
A future multi-writer profile must define origin coordination before it may
claim conformance; it is intentionally outside phase 1.

Processing an application candidate materializes or reuses:

- `contact.created`;
- bootstrap and pairwise `contact.attached` edges;
- `contact.useDid`;
- responder `did.created` with role `relationship`;
- `relationship.established`; and
- one deterministic handoff-response `message.out` for the committed initial
  message.

These events and any new objects SHOULD be one `Vault.commit`. A tombstoned
deterministic contact is not recreated; a genuinely new relationship requires
a fresh initiator relationship key. One key presented under different canonical
initiator DIDs is a sender-DID conflict.

### 10.1 Contact IDs

A user-created contact uses a UUIDv7 `cid`.

An automatic handler adopting an ordinary authenticated channel uses:

```text
cid = UUIDv5(
  bc4ed155-49e2-58d4-93da-a4ec78ff2f58,
  RFC8785(["v1", myKey, peerKey])
)
```

For a responder receiving an initial message at a rendezvous DID, see section 10.

`relationship_id` is the deterministic value defined by the rendezvous
processing profile over the exact rendezvous DID and authenticated initiator
key. It deliberately excludes the initial-message wire ID. Retries and later
initial messages from the same initiator key therefore reuse one contact; each
initial message still has its own protocol thread and response effect. A live
`contact.deleted` tombstone for this deterministic ID prevents automatic
recreation.

`peerKey == null` MUST NOT be automatically adopted without an
application-specific authenticated discriminator.

### 10.2 Receive and establish a relationship

For a delivery potentially addressed to a rendezvous key:

1. while unlock/recovery is incomplete, leave the delivery pending;
2. once local key state is authoritative, classify exact recipient
   key-agreement methods under section 9.1, deferring only recoverable cases;
3. safely classify terminal wrong-recipient input, pickup-ACK when mediated
   and create no portable message state;
4. decrypt, authenticate and run section 9.2's pre-vault checks;
5. prepare retained content and exact sender-resolution evidence, then under
   the writer lock run section 9.3's duplicate and integrity checks;
6. commit/reuse exact `peer.resolved` evidence first, then use its event ID in
   a separate `Vault.commit` of retained bytes and `message.in` with its new
   receipt ordinal and section 9.3's nullable `peerTransition`, retaining the
   same lock. Only a bootstrap candidate consumes a matching one-use invitation;
   afterward ACK mediator delivery; and
7. for continuation input, validate and commit any required transition under
   section 12 first. Then derive the input's relationship scope under
   `distributed-delivery.md` section 9. A pending transition has no provisional
   bootstrap scope. Missing evidence defers; integrity or scope conflicts
   suppress new effects. There is no expiry or approval wait.

With an application candidate already committed, perform the steps below.
Continuation traffic instead uses ordinary relationship processing under
section 12, without selecting another origin, handoff or relationship DID.
Control and other non-handoff input instead follows section 10's ACK-only
processing and cannot choose an origin or enter these materialization steps:

1. derive the stable relationship, contact and local pairwise DID IDs;
2. acquire the writer lock and recheck current tombstones, relationship-DID
   lifecycle and integrity evidence;
   suppress new work if they prohibit it, without undoing durable receipt or
   invitation consumption;
3. reuse existing frozen relationship material. Otherwise, choose this origin;
4. for first materialization, reuse the committed root relationship DID and
   its frozen route or create it under `vault-events.md` section 16.3.
   For an existing relationship, use `currentLocalDid(R)` under its section
   12.4. Apply `distributed-delivery.md` section 8.1's local-sender gate before
   selecting a response under section 11; with no usable sender, leave that
   response unfinished without committing intent or recreating a DID;
5. use `Vault.commit`, preferably once for all new objects and events:
   any new `contact.created`, bootstrap/pairwise `contact.attached`,
   `did.created`, `contact.useDid`, `relationship.established` and response
   `message.out`. The response scope comes from the previous input commit;
6. only after the required relationship facts and intent commit, reconcile
   registration of the selected local DID canonical short form;
7. prepare with that sender's disclosure and frozen-proof rules under
   `vault-events.md` sections 12.2 and 12.4; and
8. submit while eligible under the common outbound rules. Committed
   `delivery.submitted` completes that response MID independently of handoff
   confirmation.

A crash between input and materialization commits resumes these steps from
portable history. It creates neither a second invitation consumption nor a
different execution identity. Ending a relationship uses contact deletion and
DID/route retirement.

Repeated initial messages from the same stable initiator key reuse the
relationship but remain separate application messages. Until an authenticated
message arrives in that relationship's scope at the responder pairwise DID,
every package from that DID uses its long form and frozen `fromPrior`.
Human-authored messages are ordinary traffic and never choose the origin or
rotation proof.

## 11. Handoff response

### 11.1 Response selection

A handoff response is selected only for an application candidate under section
10, never for control or other non-handoff input, including on recovery.
It MUST be deterministic and machine-generated. The responder selects exactly
one:

1. Trust Ping `ping-response` when `response_requested` is not false;
2. a protocol-defined automatic response that is a pure function of the
   received message and durable portable policy, contains no human-authored
   content and does not read the current clock; or
3. `https://didcomm.org/empty/1.0/empty`.

Human-authored content is an ordinary later message. It may carry the frozen
`from_prior` while handoff is unconfirmed, but it is never selected as the
handoff response and does not determine rotation timing.

For Trust Ping:

```text
handlerId  = https://didcomm.org/trust-ping/2.0
effectKind = ping-response
ordinal    = 0
```

For relationship ID `9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3` and origin wire ID
`019b4d12-090a-7c3b-92f7-ac2c51f50db4`, the committed origin input derives:

```text
executionScope = {"relationship":"9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3"}
executionId    = 17ac2c56-1758-5167-9d57-1d1f9a2aa6cd
```

The Trust Ping response's fixed vector is:

```text
effectKey    = 9Pg0QtQFIY1RVu9QGLydHQb06X49kHkMJhi8E_jeHGs
mid = wireId = 058b727b-49c3-565f-a63e-7100fc9ce04c
```

The deterministic Empty fallback uses the same execution ID and the pure-ACK
handler, kind and ordinal from `distributed-delivery.md` section 8.2:

```text
effectKey    = 5WQAS3jcmqIY47WYO06hB2obsFUM_U--4bKqYRy0PQ4
mid = wireId = d72003b7-4952-5185-b1f3-0601c48c056a
```

Response timing is deterministic per triggering message:

```text
response.created_time = triggering_message.created_time
response.expires_time = null
```

The initial handoff's rotation proof is independent of the response:

```text
from_prior.iat = rotationTime
```

A null response creation time omits its wire header. The handoff has no expiry
by default, so receipt of an old or expired initial can still produce it.
When first materializing the relationship, sample integer Epoch Seconds
`rotationTime` once while holding the writer lock and freeze it in the compact
proof committed with `relationship.established`. It is the rotation instant,
independent of the possibly old, future or absent input creation time, as
required by [DIDComm JWT Details](https://identity.foundation/didcomm-messaging/spec/v2.1/#jwt-details).
No network effect precedes that commit. A crash before it may choose new
uncommitted material; after it, recovery and packages requiring this initial
handoff proof reuse it without sampling again. Later local ends use
`vault-events.md` section 12.4's per-edge proofs. The wire examples use
`rotationTime = 1788442810`.

For origin inbound MID `8fa18330-6cb7-5ff2-b9b8-603c0a568194`,
see the Trust Ping handoff vector above.

### 11.2 Exact `from_prior` construction and handoff headers

The initial handoff's compact JWT is constructed once and stored byte-exact. Its
protected `kid` is authorized by the local rendezvous DID document identified
by the selected origin input's `myKey` through `vault-events.md` section 14.3's
reverse key index, using that DID's disclosed long form. This is distinct from
`originResolution`, which pins the initiator's sender document.
The JWT payload is:

```json
{
  "iat": 1788442810,
  "iss": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
  "sub": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document"
}
```

Normative equality rules are:

- `iss` is the exact rendezvous DID spelling presented in the origin invitation
  or pinned resolution snapshot;
- the DID portion of protected `kid` is byte-for-byte equal to `iss`;
- `sub` is the responder relationship Peer-DID long form;
- while the proof is carried, plaintext `from` is byte-for-byte equal to
  `sub`; and
- plaintext `from`, protected `skid` and decoded `apu` all use that same long
  form.

The first handoff response MUST:

- address the authenticated initiator DID (`P_B` for an Estoc initiator);
- preserve protocol threading and OOB `pthid` where applicable;
- include the eligible ACK targets under `distributed-delivery.md` section
  8.1, including the triggering wire ID when the sender requested it;
- include `please_ack: [""]` to request explicit handoff confirmation;
- carry the exact proof required by the selected local end under
  `vault-events.md` sections 12.2 and 12.4; and
- be committed as `message.out` before recipient registration, resolution,
  encryption or submission.

Trust Ping response example:

```json
{
  "id": "058b727b-49c3-565f-a63e-7100fc9ce04c",
  "type": "https://didcomm.org/trust-ping/2.0/ping-response",
  "from": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "from_prior": "eyJ...",
  "please_ack": [""],
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "body": {}
}
```

Empty fallback example:

```json
{
  "id": "d72003b7-4952-5185-b1f3-0601c48c056a",
  "type": "https://didcomm.org/empty/1.0/empty",
  "from": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "from_prior": "eyJ...",
  "please_ack": [""],
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "body": {}
}
```

### 11.3 Registration and submission order

The responder:

1. with the candidate input already committed under section 10.2,
   uses `Vault.commit` for relationship state and response `message.out`;
2. reconciles recipient registration for the selected current local end's
   canonical short form on its bound route when mediated;
3. prepares the exact response using that local end's disclosure and proof
   rules under `vault-events.md` sections 12.2 and 12.4; and
4. submits it.

Intent always precedes effects.

### 11.4 Messages before handoff confirmation

The responder SHOULD submit the selected handoff response before unrelated
ordinary messages.

Until an authenticated message in this relationship's unique conflict-free
scope has been received at `P_A`, every new package
sent from `P_A` to this relationship MUST:

- use the responder Peer-DID long form in plaintext `from`, `skid` and `apu`;
  and
- carry the same byte-stable stored `fromPrior` whose `sub` equals that long
  form.

After confirmation, new packages omit `from_prior` and may use the canonical
short form. Already prepared exact packages are not rewritten.

Later local relationship rotations follow `vault-events.md` section 12.4's
same per-successor confirmation rule. Its current local end and corresponding
proof govern new packages, including later deterministic replies to candidates
still sent to the original rendezvous DID. The initial handoff proof remains
historical and is never regenerated for a successor.

## 12. Initiator replies, transition and confirmation

The rotation-validation steps below also apply when a responder receives its
peer's later rotation at a local relationship DID or at that relationship's
original rendezvous DID. Its first predecessor
snapshot is `relationship.established.originResolution`, the selected origin
inbound's exact `peer.resolved` evidence; later steps
use the named historical predecessor evidence, just as for the initiator.

On the initiator, before processing incoming traffic, recover any missing
`relationship.initiatorBound` from the retained initial package under
`vault-events.md` section 12.3 and commit it. The binding starts at the pinned
peer DID/key before any response. A known sender DID does not prove that this
portable binding exists. Reuse consistent evidence; missing evidence defers
processing and incompatible attribution conflicts.

An authenticated ordinary response or pure ACK from the pinned peer DID uses
that relationship directly. It needs no `from_prior`, new binding or handoff
confirmation. Process explicit ACKs and eligible deterministic responses under
`distributed-delivery.md` sections 8–9. The same rules apply to responses to
subsequent initial attempts belonging to that relationship. Section 13 defines
no-handoff error classification and per-attempt diagnostics.

The prior and successor canonical DIDs MUST differ. `iss == sub`, including
two spellings of one numalgo-4 DID, cannot authorize a same-DID document/key
update. This profile follows [DIDComm Rotation Limitations](https://identity.foundation/didcomm-messaging/spec/v2.1/#rotation-limitations):
same-DID updates need a separate continuation mechanism, which phase 1 does
not define. The pinned-document multi-key rule in section 5.1 needs no update.

When an incoming message carries `from_prior`, including from an already known
sender or after an earlier direct reply, validate and recover it as follows:

1. require `from_prior.sub` to equal plaintext `from` and the DID portion of
   authcrypt `skid` byte-for-byte, with exact decoded `apu` consistency. For
   numalgo 4, require valid long form on first disclosure; another supported
   DID uses its validated exact spelling under section 5.1;
2. use `from_prior.iss` to look up retained predecessor evidence for the
   exact local recipient in `relationshipRecipientKeys(R)` under
   `vault-events.md` section 14.4. This includes the responder's original
   rendezvous, without making it a local-chain member. Require one unique
   relationship with that recipient and predecessor evidence; neither the
   shared rendezvous nor `iss` alone identifies `R`. For the first transition,
   use the pinned initial resolution on the initiator or `originResolution` on the
   responder; for a later transition, use retained
   resolution evidence for that relationship's predecessor. Require the exact
   presented `iss` and authorized authentication `kid` to match that snapshot.
   Neither a new resolver result nor matching thread IDs substitutes for it;
3. verify the JWT signature and claims, including an integer Epoch-Seconds
   `iat` representing the rotation instant. Do not require it to equal any
   initial message's `createdTime` or use it to choose between snapshots or
   competing transitions. This follows
   [DIDComm DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation).
   Our local writer freezes its independently sampled rotation instant under
   section 11.1 for the first handoff or `vault-events.md` section 12.4 for a
   later local rotation; the receiver does not require equality with an input
   timestamp;
4. validate protocol threading when the message claims to answer an initial
   attempt; an independent ordinary message may also carry rotation proof;
5. validate `peer.transitioned` for that same relationship, contact and local
   key under `vault-events.md` section 11.2. Commit it and the new channel
   evidence before deriving its carrier's execution ID or selecting a response
   intent. The initial binding and its references are unchanged;
6. only after all required evidence is committed, process explicit `ack`; and
7. honor any eligible ACK request with the existing deterministic response
   selection, committing that intent in a separate `Vault.commit` before
   preparation or submission.

Missing historical evidence defers processing; an invalid proof is a failure
and cannot be ignored to use a direct-reply or new-bootstrap path. No ACK or
effect may run in a provisional relationship derived from the successor key.
After a transition commits, a later message need not carry its proof once
the sender's disclosure is confirmed. At the original rendezvous, its
`message.in.peerTransition` retains the exact transition used to recognize the
successor; on local relationship keys the ordinary chain-membership rule
applies. Both require authenticated DID/key authorization by that retained
successor document. Missing references defer and conflicting evidence blocks;
neither permits a bootstrap fallback. These are ordinary relationship messages,
so they do not select a handoff, replace the origin or consume an invitation.

A different DID with neither a carried proof nor committed continuation does
not join this relationship or ACK its outbounds by thread or wire-ID equality.
It needs its own valid scope; only an eligible new bootstrap candidate may
derive a new relationship under section 10. Reopen recovers unfinished initial
bindings, transitions and committed inbound work under `vault-events.md`
section 16.1, even after pickup ACK and without mediator redelivery.

A response acknowledges the initial message only when its authenticated
explicit `ack` names that wire ID. When a valid rotation response requests an
ACK, the confirmation goes to the verified current peer DID and uses no
`please_ack`. Its submission completes at committed `delivery.submitted`.
Binding and transition evidence MUST precede the confirmation-intent commit;
a crash between them reconstructs the same execution ID and response intent
selection from committed history. Duplicate input may resume eligible
unsubmitted work but never resends a submitted confirmation.

Our responder stops attaching its frozen `from_prior` after receiving an
authenticated message from its relationship peer addressed to its new local
DID. Explicit acknowledgment of the handoff still requires `ack` naming its
wire ID. A remote peer that never rotates has no such confirmation gate.

## 13. Remote errors and integrity failures

The local all-valid-input receive path has no policy rejection response. Known
integrity failures follow section 9.3's terminal receive path and produce no
peer-visible effect. There is no rendezvous `decline`, local rejection handler,
rejection vector or Estoc policy/capacity/expiry wire-code table.

Remote peers may still decline an initial interaction. A valid no-handoff
error uses `https://didcomm.org/report-problem/2.0/problem-report` or the
initial protocol's defined error type, with no `from_prior` or `please_ack`.
It must authenticate in the initiator's bound relationship through a DID/key
pair in the pinned initial document. Its explicit `ack`, if any, is validated
under the ordinary scoped membership rules; it proves receipt only.

For Report Problem, `pthid` names the triggering message's `thid`, or its wire
ID when `thid` is absent, following
[DIDComm Problem Reports](https://identity.foundation/didcomm-messaging/spec/v2.1/#problem-reports).
An error of another protocol follows that protocol's content and correlation
rules. A remote diagnostic code is preserved; a local Estoc-code allowlist is
not required to receive it.

Such errors are control observations under `vault-events.md` section 14.7 and
generate no automatic response. Its section 14.6 displays a uniquely
correlated retained reason beside the initial attempt. Ambiguous correlation
does not assign a reason to an arbitrary attempt. The error cannot change the
relationship, extend its key chain, satisfy section 8's qualifying-inbound
rule, or reopen a submitted outbound. Ordinary direct replies and pure ACKs
use their usual protocol rules in the same relationship scope.

## 14. Retry, replacement, rollover and expiry

An initial sender uses bounded local retry only before `delivery.submitted`
commits. Recommended defaults for that unsubmitted work are:

```text
minimum automatic retry interval = 30 seconds
exponential backoff cap = 21600 seconds
transport-attempt budget per wire ID per active runtime = 32
mandatory absolute stop = expires_time, when non-null
```

The sender SHOULD use these defaults and MAY choose a slower or stricter local
policy. All retry tasks in one runtime share a wire ID's budget and count an
attempt before invoking transport, including failure and unknown outcomes.
The budget and backoff are local scheduling policy, not a portable lifetime
submission cap; restart, restore or loss of `local/` may reset accounting.
None of those resets reopens a MID with committed `delivery.submitted`.
The common completion rule also applies to handoff and confirmation
responses; missing ACK or a duplicate inbound never reopens a submitted MID.

Expiry is frozen in `message.out` and MUST NOT be extended by retry or restart.
With non-null expiry, no attempt is permitted at or after it. A terminal
failure or proof gate also forbids work. An outcome-unknown attempt reuses the same
permitted exact package. Absence of `delivery.submitted` is not evidence that
no transport call occurred, and mediator idempotency does not count attempts.
A hard crash-persistent cap would require durable pre-call reservations and a
separate accounting contract; phase 1 does not introduce one. Another attempt
after terminal expiry requires a new initial message and wire ID.

Other rules:

- retrying one prepared package preserves identical plaintext and ciphertext;
- a permitted route change for an unsubmitted MID creates a new package while
  preserving logical intent;
- before local rotation, a new initial message with the same initiator key
  reuses the stable relationship but is a distinct application message;
- the same key under another canonical initiator DID is a conflict;
- an initial candidate has no acceptance deadline; its deterministic
  response follows its own frozen timing under section 11.1; and
- duplicate initial/response delivery may resume eligible unsubmitted work
  using the same frozen response or ACK intent; after `delivery.submitted`,
  it causes no resubmission or replacement effect.

A Peer rendezvous DID has no in-place key or route rollover. Changing the
mediator encoded in its document creates a new rendezvous DID and invalidates
old printed or cached invitations unless the old route remains available.
Changing a pairwise Peer DID route likewise requires a contact-scoped DID
rotation under `vault-events.md` sections 12.4 and 16.7, or continued operation
of the old mediator. A mediation arrangement is vault-scoped and reusable;
`mediation.selected` changes the default for new routes, not existing
relationship DIDs. This profile defines the local transition for one
relationship, not a vault-wide mediation-migration transaction.

## 15. Phase-1 execution and deferred replication

Phase 1 permits exactly one active writable full vault runtime. It may run in a
local application or on a server. It uses ordinary Coordinate Mediation and
account-scoped Message Pickup; no `replica_id` appears in peer or mediator wire
messages.

`replica-mediation/1.0` and `vault-sync/1.0` are deferred. Their absence MUST
NOT block local vault operation, rendezvous, pairwise communication, export or
seed recovery. The local `replica_id` remains the event author so replication
can be added later without changing event envelopes.

Concurrent bootstrap materialization by several full replicas, origin coordination and
per-replica pickup are not phase-1 conformance claims.

## 16. Privacy, abuse, interoperability and security

A disclosed rendezvous DID is intentionally correlatable within its audience.
A reusable Peer rendezvous DID can be shared without DNS but remains linkable.

Relationship DIDs are disclosed only inside encrypted DIDComm messages. They
MUST NOT appear in reusable OOB invitation plaintext or public discovery
material.

Registering rendezvous and relationship DIDs under one mediation account lets
the mediator correlate them. Separate arrangements may reduce this metadata
link, so the pairwise DID's `boundRoute` may differ from the rendezvous ingress
route.

Every otherwise valid initial is received without a message-type, size or
lifetime policy. Authentication and integrity checks remain mandatory. Source
rate limits and concrete ingress/storage exhaustion bound operational load;
ordinary contact deletion and content erasure remain available after receipt.

The profile uses DIDComm v2.1 DID rotation (`from_prior`) when a DID changes,
and explicit `ack` for receipt. The initial local binding permits communication
with the pinned peer DID without implying remote admission. A peer may keep
that DID and process standard Trust Ping or application messages normally;
the UI MUST NOT label that valid direct communication an unconfirmed handoff
merely because no rotation occurred. When a rotation is presented, its proof
and current-address rules still apply.

Loss of an initial, handoff or confirmation after committed
`delivery.submitted` does not cause automatic resubmission of that MID.
For bootstrap loss before local rotation, recovery is a new initial message
under section 14; on our responder it
passes the same receive and integrity checks and commits as another candidate
under `vault-events.md` section 14.4. Missing receipt information never reopens
submission or substitutes for authentication or rotation proof.
After local rotation, a new ordinary message to the current peer end may
carry the retained proof under that document's section 12.4, including when
the peer retains its original rendezvous or public DID. No prior peer rotation
is required. A new initial intent cannot continue the old relationship.

## 17. Required conformance cases

1. A complete bootstrap works with only a long-form `did:peer:4` invitation;
   no domain or Web DID is required.
2. External `did:web` resolution is constrained against SSRF and pins the exact
   initial-message document. A changed current document cannot replace that
   snapshot for handoff verification.
3. No emitted message has an `https://estoc.dev/rendezvous/1.0/*` type.
4. The default initial Trust Ping has `response_requested == true` and
   `please_ack == [""]`; absent `response_requested` is interpreted as true.
5. `please_ack: []` is accepted but requests no explicit message ID.
6. Valid initial messages have no initial-specific type, byte or lifetime
   restriction. Null expiry and already-expired wire timestamps do not prevent
   receipt or later materialization; common syntax and integrity still apply.
7. Unknown application types are retained without executing an unsupported
   handler, including invitation-attached messages.
8. OOB invitation ID is used as `pthid` for the resulting interaction.
9. Initiator intent precedes registration, resolution, preparation and
   submission.
10. Peer first disclosure uses the same long form in `from`, `skid` and `apu`.
11. Before unlock/recovery completes, recipient ownership is not classified.
    Afterward, only an exact known local key-agreement method with a
    recoverable missing prerequisite remains pending without pickup ACK;
    sender-resolution unavailability is bounded under section 5.1, while
    recoverable local prerequisites have no such budget.
12. Safely classified hard rejection is pickup-ACKed and creates no portable
    candidate.
13. There is no user approval or admission-policy wait after `message.in`.
14. Known tombstone, sender-DID and unavailable-invitation failures create no
    new candidate, contact or response; mediated input is pickup-ACKed.
15. A committed application candidate survives restart before materialization; recovery
    finishes its relationship and eligible response without another decision.
16. Neither sender expiry nor later rendezvous retirement removes a durable
    candidate. It can finish through a live pairwise route. Tombstones and
    integrity conflicts suppress new work without erasing historical scope or
    reopening an invitation.
17. Stable relationship/contact/responder-DID, relationship-scoped execution
    and effect vectors recompute from the published inputs.
18. `relationship.established` retains its selected origin and exact sender
    `originResolution`, contact, local DID, peer, handoff MID and compact
    `fromPrior`; derived DID, proof and effect values follow those immutable
    sources under `vault-events.md` section 12.2.
19. `from_prior.iss` and protected `kid` use the exact pinned prior-DID form.
20. `from_prior.sub` equals plaintext `from` exactly; before confirmation both
    use responder Peer-DID long form.
21. The initiator verifies rotation against its binding's exact pinned
    predecessor snapshot using `iss` and `kid`. A valid remote rotation `iat`
    need not equal initial `createdTime`; neither timestamp nor a new resolver
    result chooses another snapshot. The successor may be a supported public
    DID or Peer DID, with numalgo-4 long form required only when applicable.
22. Handoff response is deterministic: Trust Ping response, deterministic
    protocol response or Empty ACK; human-authored content is ordinary later
    traffic. Only application candidates select one under section 10.
23. The handoff freezes eligible requested ACK targets and requests its own
    ACK with `please_ack: [""]`. A remote initial without a receipt request is
    still received and gets a handoff with no invented ACK target.
24. The handoff Empty example uses the pure-ACK ID derived from its logical
    execution ID and freezes its response intent.
25. A handoff response stops submission when `delivery.submitted` commits,
    even without ACK or pairwise confirmation. Duplicate initial receipt does
    not resend it; its envelope needs no further delivery retention.
26. The committed origin input derives relationship/wire-ID execution scope
    before materialization; a response cannot use its own proposed input batch.
27. Until confirmation, every responder package carries the same stored
    `fromPrior` and uses long-form sender spelling.
28. Local integrity failures generate no rejection effect. Remote Report
    Problem codes are preserved and classified by authenticated scope and
    protocol correlation, without an Estoc-code allowlist.
29. Default local retry for unsubmitted initials uses a 30-second minimum,
    21600-second backoff cap and 32 pre-counted transport attempts per MID per
    runtime. A null expiry is legal; a non-null expiry and committed submission
    remain permanent stopping boundaries despite restart.
30. Peer rendezvous mediator replacement requires a new DID/invitation unless
    the old route remains available.
31. Ordinary `writeTo` excludes our rendezvous sender but includes a peer
    that keeps its pinned or verified original rendezvous or public DID after
    qualifying inbound evidence under section 8. An accepted
    remote `did:web` initiator can receive our pairwise handoff and later replies
    without supplying a Peer-DID long form.
32. Phase 1 works with one active full runtime and standard account-scoped
    pickup; replica mediation and vault sync are not required.
33. Direct authenticated communication using the pinned DID needs no
    handoff and is not displayed as unconfirmed rotation. A presented invalid
    proof blocks ACK/effects and a new DID without proof cannot join the old
    relationship. Missing ACK never reopens a submitted outbound.
34. With the vault unlocked and recovery complete, a foreign recipient DID,
    a local DID with a nonexistent/wrong-purpose fragment, or a retired
    rendezvous DID is terminal wrong-recipient input and does not remain
    pending. A retired relationship DID with a valid non-terminal bound route
    still receives eligible input normally, without re-registration; contact
    deletion applies the late-message cleanup and permits no resurrection.
35. An exact known local key-agreement method with recoverable missing
    key/document/route state remains deferred without pickup ACK; a retired
    bound route is terminal. A locked or recovering vault is never classified
    as wrong-recipient merely because keys are unavailable.
36. The initiator commits its initial package, then separately its binding,
    before first submission. It needs no reply to recover that binding. Required
    transition evidence commits before its response intent; a crash between
    commits resumes from that prefix without mediator redelivery.
37. Later verified peer-key rotation preserves that relationship execution
    scope and does not create a second automatic effect for the same wire ID.
38. A known responder DID does not skip missing binding or transition
    recovery. Each prerequisite commits before a dependent response intent;
    proposing them together cannot supply the intent's execution scope.
39. A previously committed/imported transition prefix is completed from pinned
    evidence without minting another relationship or provisional execution ID.
40. Pickup-ACKed inbound work is recovered from portable history without
    mediator redelivery or local queues.
41. A valid new candidate consumes a matching local one-use invitation in
    its inbound commit, before materialization. Crash, detach, deletion and
    erasure cannot reopen it; further candidates for the same consumer reuse it.
42. A remote no-handoff error authenticates in the initiator's bound
    relationship. Its valid ACK records receipt; a uniquely correlated retained
    reason appears beside the initial attempt without changing delivery rules.
43. A crash after an application candidate commits but before materialization
    resumes from that candidate without redelivery. No separate acceptance or
    rejection event must be recovered and no optional local rejection response
    is invented.
44. A new consumer of an unavailable one-use invitation fails integrity
    before inbound commit; same-consumer reuse is permitted.
45. Concurrent local receives serialize integrity checks and input commit.
    Imported incompatible consumers keep a one-use invitation unavailable and
    suppress affected effects; fold order cannot choose a winner.
46. Handoff timing copies nullable input creation time and uses null expiry.
    `fromPrior.iat` freezes the independently sampled rotation instant, even
    for an old or timestamp-free initial; duplicates never change the proof.
47. OOB and manual discovery commit non-null `message.out.initial` with the
    selected local DID and exact presented peer DID. Later sends before a
    qualifying inbound remain initial, with common nullable expiry and no
    initial size limit. Explicit-channel sends fail before intent commit
    without target rewriting. Direct replies, pure ACKs and verified rotation
    qualify; no-handoff errors do not.
48. Restore after package commit but before binding reconstructs the binding
    from `initial` and package evidence without OOB, content or peer reply.
    Later inbound evidence never reclassifies that initial MID. A retained
    ordinary outbound is not guessed to be a missing initial binding.
49. Before the first package of each new outbound to a non-numalgo-4 DID,
    the preparer performs and commits fresh resolution; unavailable resolution
    leaves work retryable. If no usable chain key remains it records
    `peer-key-changed` before preparation. Retrying or repacking an existing
    MID does not fetch a new document. A same-DID new-key inbound without proof
    at the old local relationship DID has no scope or effect, only a contact
    diagnostic. A fresh local DID/key can start a new relationship.
50. On both endpoints, a reply using a second key-agreement key already in
    the pinned initial document has the same relationship scope and processes
    its ACK normally. A key appearing only in a fresh document does not join.
51. Initiator relationship ID derivation uses its authcrypt key-agreement
    public key, not its authentication signing key, and agrees with the
    responder's peer key derived through `message.in.peerResolution`.
52. Each non-numalgo-4 sender delivery resolves current authentication
    evidence, including duplicates. A removed key fails even if pinned in the
    chain; resolver unavailability defers without pickup ACK only within
    section 5.1's budget. An unchanged fresh document permits matching
    evidence reuse. A crash before inbound
    commit requires fresh resolution again; committed input recovers offline
    from retained evidence without revoking historical scope. Not-found,
    deactivated, invalid/mismatched-document, unsupported-method and
    SSRF-forbidden results are terminal, with pickup ACK and no `message.in`.
    A derived-resource 404 differs from a transient timeout/5xx; a definitive
    error from a resolver takes precedence over its enclosing HTTP status.
    NXDOMAIN and NODATA across all usable address families are definitive;
    an empty AAAA answer with a usable A answer is not. SERVFAIL, DNS timeout,
    connection refusal/timeout and TLS validation failure are unavailable.
    Repeated 503 or stalled connections reach the local budget/retention stop
    and take the terminal pickup-ACK path with no portable input. Redelivery
    and reconnect share the budget; scheduled retries need no new delivery.
    Success before exhaustion receives normally. Locked/recovering or missing
    local-key/evidence input cannot take this budget's rejection path.
53. A pure ACK at a rendezvous DID retains scope and processes valid ACKs but
    creates no handoff or relationship, including after restart. An eligible
    control ACK request uses only a generic pure ACK from an existing usable
    relationship DID under `distributed-delivery.md` section 8.1's common gate.
    No-handoff errors get no response. Unmatched or invalid Empty,
    `ping-response` and Report Problem input cannot select a handoff either.
    An application candidate still materializes and selects its normal response.
54. Required reply work for input at a retired relationship DID waits without
    committing intent when no usable local sender exists. A valid successor
    resumes that work in the same relationship; current tombstones still block.
55. Local rotation uses `vault-events.md` section 12.4's event, proof,
    confirmation and repack rules. A direct reply to the initiator's exact
    local predecessor qualifies it to rotate even when the peer retains its
    public or rendezvous DID. Send ordinary traffic and the retained proof to
    that current peer end; do not create a new-key initial. All local initial
    attempts use their sender's long form, preserving the exact spelling
    needed by later predecessor proofs.
56. Section 3's application-candidate definition includes Trust Ping `ping`
    with either response-request value and unknown application types. It
    excludes the three named control types even if they fail the control
    predicate, and excludes other valid control observations. An unmatched
    protocol-specific error outside those types is application input unless
    its valid control predicate excludes it. Unattributed non-handoff input
    appears in no contact thread and MAY be surfaced as unattributed input.
57. Reusing one local relationship DID for initial bindings to two different
    canonical rendezvous DIDs conflicts both relationships under
    `vault-events.md` section 14.4, including when the second binding arrives
    through import. A fresh relationship uses a fresh local DID; later initial
    attempts in the same bound relationship reuse its root only before local
    rotation. Contact merges and retirement do not permit cross-relationship
    reuse, and a rotated successor cannot start another initial in the old `R`.
58. Given P0 already bound in `R`, a P1 message to the same original rendezvous
    with a valid P0-to-P1 `from_prior` extends `R`, preserving contact, origin,
    local DID, ACK scope and the original invitation consumer. No new-key
    relationship or handoff is created. A later proof-free P1 message freezes
    `peerTransition` and uses ordinary relationship processing after restart
    or import. Original-key initial retries still use their original binding.
59. At a shared rendezvous, prior DID lookup also requires the matching
    original recipient and exact retained predecessor document. Missing proof
    evidence defers effects; invalid proof and ambiguous bindings cannot
    authorize another relationship. A recognized successor with a fresh but
    unbound same-DID key gets no scope and cannot become a new candidate.
60. A carried-proof input commits before its transition and before any
    dependent response intent. A crash at either boundary recovers from the
    retained evidence without a provisional bootstrap effect or new invitation
    consumption. Missing `peerTransition` references on imported proof-free
    inputs defer instead of reclassifying them by their new sender key.
