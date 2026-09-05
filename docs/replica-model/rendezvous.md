# Estoc Rendezvous and Pairwise Bootstrap Profile 1.0

Status: **draft, phase 1** — a single-active-runtime processing profile for
bounded discovery and privacy-preserving handoff from a vault-scoped
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
application message to send uses Trust Ping 2.0. A responder hands the
relationship from the rendezvous DID to a pairwise DID with the standard
DIDComm `from_prior` header.

## 1. What it is for

The DID used to discover a vault need not remain the DID used inside an
ongoing relationship. Estoc separates:

- a **rendezvous DID**, disclosed so an unknown party can send an initial
  encrypted DIDComm message; and
- a **relationship DID**, a pairwise `did:peer:4` used after admission.

The required default rendezvous path is a self-resolving long-form
`did:peer:4`. It can be shared by QR code, OOB URL, file, NFC, local exchange
or another invitation transport without a domain or online DID resolver. An
implementation MAY also expose a reusable `did:web` facade for public
directory discovery.

Both forms enter the same flow:

```text
Alice discloses rendezvous DID R_A
                 │
                 │ Bob sends ordinary initial message X
                 │ from pairwise DID P_B to R_A
                 ▼
        Alice applies bounded admission
                 │
                 │ accepted
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
- Report Problem 2.0 (`https://didcomm.org/report-problem/2.0`) when an
  explicit rejection is emitted;
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Peer DID Method numalgo 4;
- RFC 8785 JSON Canonicalization Scheme;
- `distributed-delivery/1.0`; and
- `vault-events.md`.

Phase 1 uses ordinary Coordinate Mediation and account-scoped Message Pickup
when a mediator is used. `replica-mediation/1.0` and `vault-sync/1.0` are
informative deferred extensions, not dependencies of this profile.

## 3. Terms

- **Rendezvous DID** — a vault-scoped DID with role `rendezvous`. Version 1.0
  requires the Peer DID profile and optionally supports a Web DID profile.
- **Peer rendezvous DID** — the default self-resolving `did:peer:4` profile.
- **Web rendezvous DID** — an optional `did:web` facade whose exact document
  revision is pinned before the initial package is submitted.
- **Relationship DID** — a vault-scoped pairwise `did:peer:4` created for one
  relationship.
- **Initial message** — the first ordinary DIDComm application message sent
  from an initiator relationship DID to a rendezvous DID.
- **Bootstrap candidate** — an authenticated initial message that has passed
  the hard pre-vault gate and may be admitted into the vault.
- **Initial-message policy set** — message types a rendezvous generation
  expects or may auto-handle after durable admission. It is not a hidden
  pre-vault interoperability gate.
- **Admission decision** — a durable local decision to `accept`, `reject` or
  `ignore` one bootstrap candidate. It is not a wire message.
- **Deterministic protocol response** — an automatic response whose complete
  portable intent is a pure function of the triggering inbound message and
  durable policy.
- **Handoff response** — the first responder message for the relationship. It
  is a deterministic protocol response, a Trust Ping `ping-response`, or an
  Empty Message ACK, sent from the responder relationship DID with
  `from_prior`. Human-authored content is never the handoff response.
- **Handoff confirmation** — an authenticated message received at the new
  responder relationship DID. A conforming initiator also explicitly ACKs the
  handoff response.
- **Initial-message-bound resolution snapshot** — retained exact DID document
  bytes, document hash and selected key IDs used to address one initial
  message. It binds an ordinary application message, not a custom rendezvous
  protocol request.
- **Bootstrap channel** — the authenticated channel from the initiator
  relationship key to the responder rendezvous key.
- **Relationship ID** — the responder's deterministic local entity ID for
  `(rendezvous DID, authenticated initiator key)`.
- **Full runtime** — the active writable incarnation of the vault. It may run
  locally or on a server. Phase 1 has exactly one active full runtime.

## 4. Invariants

1. The initiator and responder address DIDs, never replica IDs.
2. The initial message is an ordinary DIDComm message. Trust Ping 2.0 is the
   universally supported no-content default.
3. There is no Estoc wire-level `accept` or `decline` message.
4. Admission is a local durable decision represented by
   `relationship.admissionDecided`.
5. An accepted bootstrap creates or reuses one deterministic relationship,
   contact and responder pairwise DID.
6. One relationship has one frozen `from_prior` proof and one rotation instant.
7. Before handoff confirmation, `from_prior.sub`, plaintext `from`, protected
   `skid` and decoded `apu` use the same responder Peer-DID long form.
8. `from_prior.iss` and its protected `kid` use the exact rendezvous-DID
   spelling pinned by the relationship origin; the `kid` belongs to that exact
   `iss`.
9. The transition is contact-scoped. It does not globally retire or alias the
   rendezvous DID.
10. Repeated initial messages from the same authenticated initiator key to the
    same rendezvous DID reuse the same relationship.
11. Each initial message remains a separate application message and may have
    its own deterministic protocol response and thread.
12. A deterministic contact tombstone is not resurrected by another initial
    message from the same initiator key.
13. A rendezvous DID never appears in ordinary relationship `writeTo`.
14. A mediator treats rendezvous and relationship DIDs as ordinary recipient
    DIDs and stores only encrypted inner envelopes.
15. Phase 1 has one active full runtime. The deferred replica profiles MUST NOT
    be required to implement this bootstrap.

## 5. DID profiles and resolution evidence

### 5.1 Common requirements

A rendezvous DID MUST:

- be represented by `did.created` with role `rendezvous`;
- contain or resolve to exactly one selected key-agreement method for new
  initial messages;
- contain or resolve to at least one authentication method capable of signing
  `from_prior`;
- select at least one DIDComm delivery route;
- use seed-derived key names represented by the vault; and
- have at least one live `rendezvous.generationConfigured` event.

Before the first package is submitted, the initiator MUST durably retain:

- the exact presented rendezvous DID;
- the canonical rendezvous DID;
- the exact RFC 8785 canonical resolved DID document;
- the unpadded base64url SHA-256 document hash;
- the selected authentication `kid`;
- the selected key-agreement `kid`; and
- the resolution event ID.

This is the initial-message-bound resolution snapshot used later to verify
`from_prior`. A current resolver result MUST NOT silently replace it. A later
resolution may recover missing bytes only when its canonical document hash
equals the pinned hash.

Missing historical snapshot material is a deferred verification state, not
proof that a handoff is invalid.

### 5.2 Peer DID numalgo-4 profile

Every version-1.0 relationship DID and the default rendezvous DID use Peer DID
numalgo 4. A vault stores both validated long form and canonical short form.

For a Peer rendezvous DID:

- the OOB invitation or other first disclosure MUST provide the long form;
- the initiator resolves it locally and validates its encoded input document;
- the canonical short form is used in initial-message plaintext `to`, Routing
  `forward.next` and mediator recipient registration;
- the exact presented long form is retained in the initial-message-bound
  snapshot and later used as `from_prior.iss`;
- the `from_prior` protected `kid` is that exact `iss` plus an authentication
  fragment authorized by the pinned document; and
- the selected ingress route and keys MUST equal the rendezvous long-form input
  document.

The route embedded in the responder relationship DID is independent of the
rendezvous ingress route. It MAY use another mediation arrangement to reduce
mediator-side linkability.

For an initiator or responder relationship DID, the long form MUST be used on
first disclosure. Until the peer confirms the responder handoff, every package
from the responder relationship DID uses its long form. After confirmation,
new packages normally use the canonical short form.

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
unresolved and cannot authenticate a new relationship.

### 5.3 Optional `did:web` profile

A Web rendezvous DID MUST resolve to a selected document revision containing:

- exactly one selected `keyAgreement` method for new initial messages;
- at least one `authentication` method capable of signing `from_prior`;
- at least one `DIDCommMessaging` service; and
- keys and routes equal to portable vault state.

For key generation integer `N`, the fragments are normative:

```text
#authentication-N
#key-agreement-N
```

The complete IDs are:

```text
<did:web>#authentication-<N>
<did:web>#key-agreement-<N>
```

A generation-0 document resembles:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:web:alice.example",
  "verificationMethod": [
    {
      "id": "did:web:alice.example#authentication-0",
      "type": "Multikey",
      "controller": "did:web:alice.example",
      "publicKeyMultibase": "z6Mk..."
    },
    {
      "id": "did:web:alice.example#key-agreement-0",
      "type": "Multikey",
      "controller": "did:web:alice.example",
      "publicKeyMultibase": "z6LS..."
    }
  ],
  "authentication": ["did:web:alice.example#authentication-0"],
  "keyAgreement": ["did:web:alice.example#key-agreement-0"],
  "service": [
    {
      "id": "did:web:alice.example#didcomm",
      "type": "DIDCommMessaging",
      "serviceEndpoint": {
        "uri": "did:web:mediator.example",
        "accept": ["didcomm/v2"]
      }
    }
  ]
}
```

A Web resolver used by a mediator or client MUST be constrained against SSRF,
DNS rebinding, redirects to forbidden networks, unbounded responses and DID
mismatch. Failure to resolve safely is deferred or reported as
`did-resolution-unavailable`; it never falls back to an unrestricted fetch.

The initiator pins the exact Web document revision before first submission and
later verifies `from_prior` against that snapshot even when the currently
published document has changed.

## 6. Out-of-band discovery

A reusable invitation contains a rendezvous DID, not a relationship DID.

Peer-default example:

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

Optional Web-facade example:

```json
{
  "type": "https://didcomm.org/out-of-band/2.0/invitation",
  "id": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "from": "did:web:alice.example",
  "body": {
    "goal_code": "establish-relationship",
    "goal": "Start a private pairwise relationship",
    "accept": ["didcomm/v2"]
  }
}
```

The invitation ID is the `pthid` of the initial interaction. One reusable
invitation may start many independent protocol threads. A one-use invitation
is reserved by final acceptance and permanently consumed by the resulting
relationship under `vault-events.md` section 14.10. Detach, contact deletion
and erasure do not reopen it; retries for the same consumer reuse that
relationship rather than creating another take.

An invitation may include one or more alternative protocol-message
attachments. The recipient chooses at most one supported alternative and acts
on it according to that protocol. The recipient's first outbound message in
that child interaction is the initial message defined by this profile and uses
the invitation ID as `pthid`. When the invitation supplies no usable child
protocol message, or the selected protocol has no initial outbound for the
recipient, the initiator uses Trust Ping 2.0 by default.

Relationship DIDs MUST NOT appear in reusable invitation plaintext, public Web
pages or `did:web` documents.

## 7. Rendezvous generation profile

A `rendezvous.generationConfigured` event freezes:

- the rendezvous DID and selected key generation;
- exact resolution evidence;
- accepted ingress routes;
- the independently selected route embedded in responder relationship DIDs;
- `initialMessageTypes`, an exact non-empty post-admission policy set;
- admission policy `ask`, `auto` or `silent`;
- an initial-message lifetime ceiling; and
- optional bounded auto-admission limits.

The interoperable phase-1 floor is:

```text
REQUIRED_INITIAL_LIFETIME_SECONDS = 604800
REQUIRED_INITIAL_PLAINTEXT_BYTES  = 65536
```

Every implementation MUST support Trust Ping 2.0 `ping`. It MUST NOT hard
reject solely for local policy an otherwise valid initial plaintext whose
canonical UTF-8 size is at most 65536 bytes and whose positive lifetime is at
most 604800 seconds. A generation MAY accept larger messages or longer
lifetimes. A local policy that is stricter than this floor is applied after the
candidate becomes durable and may produce a problem report.

An exact protocol message attached to an invitation created by this vault MUST
not be hard-rejected merely because its type is absent from a local preference
list. Unsupported application semantics are a post-admission policy result.

`initialMessageTypes` records protocols the product expects and may
auto-handle after durable admission. It does not authorize silent hard-gate
rejection of another syntactically valid message that satisfies the phase-1
size and lifetime floor.
It MUST include:

```text
https://didcomm.org/trust-ping/2.0/ping
```

A generation is **live** only when its key, document and route dependencies
validate and all selected mediated ingress routes are reconciled. A configured
but not-yet-live generation is deferred, not rejected.

For a Peer rendezvous generation, the sole ingress route MUST equal the route
encoded in the rendezvous DID. `relationshipRoute` MAY differ; it is encoded
in each derived responder relationship DID. For overlapping Web generations,
`relationshipRoute` is stable for an already established relationship but
need not equal a Web ingress route.

## 8. Initial message profile

### 8.1 Common requirements

A conforming Estoc initial message MUST:

- be authcrypted from an initiator relationship DID;
- be addressed to a live rendezvous DID generation;
- use the initiator Peer DID long form for first-disclosure plaintext `from`,
  protected `skid` and decoded `apu`;
- include immutable `created_time`;
- include finite `expires_time` with `created_time < expires_time`;
- have a lifetime of at most 604800 seconds; phase 1 defines no mechanism for
  a responder to advertise a larger ceiling;
- request explicit acknowledgment of the current message with
  `please_ack: [""]` or with its own wire ID;
- include the invitation ID as `pthid` when it arose from OOB discovery; and
- be durably represented by `message.out` before registration, resolution,
  encryption or network submission.

A recipient preserves the exact standard `please_ack` array. `[]` requests no
explicit message ID and does not make the initial message receipt-required.
An initial message that fails the Estoc receipt request or protocol-preference
requirements is handled after durable admission; it is not silently discarded
solely for that reason.

An otherwise valid unexpired initial message MUST NOT be rejected solely
because its `created_time` is far from the receiver's clock. Expiration and the
positive lifetime bound are the freshness limits.

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
writer emits `true` explicitly. A syntactically valid `false` value is admitted
but cannot select `ping-response`; after acceptance the deterministic handoff
uses an Empty Message ACK because the current message explicitly requested
acknowledgment.

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
wrapped in an Estoc rendezvous protocol message. Large content SHOULD be sent
after pairwise handoff; the 65536-byte floor only guarantees a small bootstrap.

### 8.4 Initiator preparation order

The initiator:

1. creates or selects its pairwise relationship DID `P_B`;
2. selects or creates the local contact and associates the disclosed
   rendezvous DID with it;
3. writes body and attachment objects;
4. appends `message.out` for the Trust Ping or application message;
5. reconciles recipient registration for `P_B` so the response is reachable;
6. resolves the rendezvous DID and appends exact `peer.resolved` evidence;
7. attaches the bootstrap channel with `because == "rendezvous"`;
8. appends one exact `message.prepared`; and
9. submits it directly or through Routing 2.0.

Steps 3–4 happen with networking disabled. Registration and resolution are
retryable effects. Phase 1 has one active runtime; another runtime MUST NOT
concurrently use the same local author.

## 9. Responder admission

### 9.1 Deferred delivery

A mailbox delivery remains pending, with no pickup ACK and no `message.in`,
only when recipient ownership cannot yet be safely classified or an exact
known local receive key has a concrete recoverable prerequisite:

- the vault is locked, recovery is incomplete, or the local key/generation
  index is not yet authoritative;
- a recipient `kid` maps to an exact known local **key-agreement** method and
  generation, but that configured generation is not yet live;
- required key/document/route state for that exact known method is temporarily
  unavailable; or
- required historical evidence for that exact known method is temporarily
  unavailable.

Once local key state is authoritative, the implementation MUST compare the
complete recipient `kid`, including DID and method fragment/purpose. A foreign
DID, a locally controlled DID with a nonexistent fragment, an authentication
fragment used where key agreement is required, a terminal generation, or a
recipient set containing no valid local key-agreement method is not deferred.
It is terminal wrong-recipient input.

A phase-1 runtime retries deferred input after its local state changes. A
future sync-enabled runtime may sync and refold first. It MUST NOT treat a
locked vault or incomplete recovery as proof that the recipient is foreign.

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. If no recipient `kid` maps to an exact live or
recoverably pending local key-agreement method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

For an exact local recipient that can be decrypted, the responder then checks
only conditions needed to classify the input safely before writing portable
application state:

- recipient DID, exact selected key-agreement method and generation;
- valid DIDComm syntax and authenticated encryption;
- valid first-disclosure Peer DID plus exact `from`/`skid`/`apu` form;
- finite, positive message lifetime not above the generation's absolute
  ceiling;
- an implementation safety ceiling above the required 65536-byte floor;
- per-source and per-rendezvous abuse rate limits; and
- emergency raw-ingress/storage exhaustion limits.

An implementation MUST NOT use this gate for a local preference about message
type, a stricter-than-baseline lifetime/size policy, relationship capacity,
recipient capacity, absence of current-message `please_ack`, or Trust Ping
`response_requested == false`.

A safely classified hard rejection received through Message Pickup:

- MUST be pickup-ACKed;
- MUST NOT append `message.in`;
- MUST NOT create a contact, relationship or response effect; and
- MAY leave only a bounded local diagnostic.

Direct transport has no pickup ACK. Malformed crypto, wrong recipient,
terminal generation and hard abuse/resource limits are examples of this gate.

### 9.3 Durable candidate and local policy

A candidate that passes the hard gate is committed as `message.in` before the
runtime ACKs mediator delivery. It is initially excluded from ordinary contact
threads until admitted.

Local policy then produces one durable:

```text
relationship.admissionDecided
```

with outcome:

```text
accept | reject | ignore
```

`ask` is the default. `auto` must be explicit and bounded. `silent` maps a
valid candidate to `ignore`; it does not bypass durable admission. Post-
admission policy handles protocol support, current-message receipt request,
stricter local size/lifetime preferences, relationship capacity, recipient
capacity, user approval and organization rules.

`vault-events.md` section 14.5 is the sole normative admission reducer. The
phase-1 writer serializes finalization and commits one final result, not a
provisional policy suggestion. User review and policy reevaluation occur while
the candidate is undecided. A final result cannot be replaced, even before
handoff intent exists; a later attempt requires a new initial message and wire
ID. Equivalent results are idempotent. Incompatible results, including different
rejection codes, are conflicts that suppress new effects rather than invoking
an outcome, source or code precedence rule.

Before final accept, the same serialized operation checks deterministic
contact tombstones, sender-DID consistency and one-use invitation availability.
When an undecided candidate would introduce a new consumer but the one-use
invitation is unavailable, the writer MUST finalize reject with code
`not-accepted`. If it chooses a Report Problem response, section 13 maps this
to `e.p.estoc.not-accepted`; rejection may still be silent. Recovery of an
existing final accept and permitted reuse by the same consumer follow
`vault-events.md` section 14.10 and MUST NOT rewrite that accepted result.
A timely final accept remains final during recovery even after the initial
message expires; the response still obeys its own frozen expiry. Ending an
accepted relationship uses normal contact deletion and DID/route retirement.

Only an effective accept materializes relationship state. Only an effective
reject may create a protocol-specific error or Report Problem. Ignore emits no
peer-visible response.

After final reject or ignore, the runtime MUST append `message.erased` for
candidate-only body, attachment and stored-message roots once any selected
rejection intent has been frozen. The final decision and any chosen rejection
intent, together with its required execution binding, MUST commit in one
`appendAll`. If no rejection intent is committed with a final reject, recovery
MUST NOT invent one. It resumes only already committed response work and
candidate erasure. The skeleton, resolution evidence and final decision remain.
A crash before erasure does not authorize later acceptance.
A pending `ask` candidate may retain content until decision or expiry, but the
product MUST bound that pending period. Independent references to shared CIDs
remain live; erasure applies to this candidate's message/root relations.

## 10. Deterministic relationship materialization

Acceptance derives stable IDs from the canonical rendezvous DID and the
authenticated initiator key, not from the initial message wire ID or type.

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

and peer key `k3j9n0m4x6q2w7c8v5p1d8s0fa`, producing:

```text
relationship_id        = 73a7d8f5-3523-5802-9b65-02da2078273e
contact_id             = 48bab320-8759-5579-b78b-531083d49d4c
our_relationship_did_id = 2a61bb7e-1578-57ea-83a1-80454032c781
```

The responder pairwise key names are derived from
`our_relationship_did_id`. The relationship DID's input document encodes
`relationshipRoute`, which may differ from the rendezvous ingress route.

The first effective accepted candidate becomes the relationship origin in the
phase-1 single-writer profile. `relationship.established` freezes:

- `originInboundMid` and the candidate's wire ID;
- its exact initial-message-bound `peer.resolved` event;
- exact presented rendezvous DID spelling;
- the selected prior authentication `kid`;
- `rotationIat`, equal to the origin candidate's `created_time`;
- responder relationship Peer-DID long form; and
- the exact compact `fromPrior` JWT.

Once frozen, later initial messages reuse the same relationship-level proof.
A future multi-writer profile must define origin coordination before it may
claim conformance; it is intentionally outside phase 1.

Acceptance materializes or reuses:

- `contact.created`;
- bootstrap and pairwise `contact.attached` edges;
- `contact.useDid`;
- responder `did.created` with role `relationship`;
- `relationship.established`; and
- one deterministic handoff-response `message.out` for the admitted initial
  message.

These events SHOULD be one `appendAll` batch. A tombstoned deterministic
contact is not recreated; a genuinely new relationship requires a fresh
initiator relationship key. One key presented under different canonical
initiator DIDs is a sender-DID conflict.

## 11. Handoff response

### 11.1 Response selection

A handoff response MUST be deterministic and machine-generated. The responder
selects exactly one:

1. Trust Ping `ping-response` when `response_requested` is not false;
2. a protocol-defined automatic response that is a pure function of the
   admitted message and durable portable policy, contains no human-authored
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

For relationship ID `73a7d8f5-3523-5802-9b65-02da2078273e` and origin wire ID
`019b4d12-090a-7c3b-92f7-ac2c51f50db4`, the relationship first commits:

```text
executionScope = {"relationship":"73a7d8f5-3523-5802-9b65-02da2078273e"}
executionId    = e5d6c70d-ee4c-5dd5-9a02-02e0726e55da
```

The Trust Ping response uses this exact closed effect input:

```json
{
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "body": {},
  "created_time": 1788442800,
  "expires_time": 1789652400,
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "relationship_id": "73a7d8f5-3523-5802-9b65-02da2078273e",
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4"
}
```

Its fixed vector is:

```text
effectInputHash = 9bPd4ZBv7IxjxhZaqz6bRDJxP8lBJC6uPa4ZR0DRhTg
effectId        = sq5uy24l9qX5IJRYZVxAauKDZeF-ucjEkXUY0SqJbOs
mid             = 3ef178eb-d708-5157-b1be-94f5ad0185c7
wireId          = 07c45e7a-5fef-5542-817b-d4ba69a16d96
```

For the deterministic Empty fallback, the closed input is:

```json
{
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "reply_scope": {
    "relationship": "73a7d8f5-3523-5802-9b65-02da2078273e"
  },
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4"
}
```

The resulting vector is:

```text
handlerId       = https://estoc.dev/distributed-delivery/1.0#pure-ack
effectKind      = pure-ack
ordinal         = 0
effectInputHash = TYl33OWYFhWry8XvOaqIP8nI9mFj0uuYP9wOXRNpc7k
effectId        = P705H2L_3dAvvsFrQqG31HMerwOyHNVK3Tlpywl3T3Y
mid             = ab5af078-1c93-55cb-9506-978d06eb126e
wireId          = c0f2ef14-bc56-5c6e-abdb-2313e31146ba
```

Response timing is deterministic per triggering message:

```text
response.created_time = triggering_message.created_time
response.expires_time = triggering_message.expires_time + 604800
```

The relationship-level rotation proof is independent of the response:

```text
from_prior.iat = relationship.rotationIat
               = origin_initial_message.created_time
```

### 11.2 Exact `from_prior` construction and handoff headers

The relationship's compact JWT is constructed once and stored byte-exact. Its
protected header contains a `kid` authorized by the pinned origin snapshot. Its
payload is:

```json
{
  "iat": 1788442800,
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

Before the first handoff effect, the responder MUST process-durably bind the
origin observation to its logical execution ID. The handoff `message.out`,
relationship state and binding SHOULD be one batch.

The first handoff response MUST:

- address initiator relationship DID `P_B`;
- preserve protocol threading and OOB `pthid` where applicable;
- include `ack` naming the triggering initial wire ID;
- include `please_ack: [""]` to request explicit handoff confirmation;
- copy the exact stored `fromPrior`;
- set `replayUntil` exactly equal to the handoff response's
  `expiresTime`, as required by `distributed-delivery.md` section 7, so a
  duplicate initial message can re-submit the exact response throughout its
  complete validity window; and
- be committed as `message.out` before recipient registration, resolution,
  encryption or submission.

Trust Ping response example:

```json
{
  "id": "07c45e7a-5fef-5542-817b-d4ba69a16d96",
  "type": "https://didcomm.org/trust-ping/2.0/ping-response",
  "from": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
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
  "id": "c0f2ef14-bc56-5c6e-abdb-2313e31146ba",
  "type": "https://didcomm.org/empty/1.0/empty",
  "from": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
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

1. process-durably appends acceptance, `message.executionBound`, relationship
   state and response `message.out` with its replay deadline;
2. reconciles recipient registration for canonical short-form `P_A`;
3. prepares the exact response using long-form sender evidence and the frozen
   `fromPrior`; and
4. submits it.

Intent always precedes effects.

### 11.4 Messages before handoff confirmation

The responder SHOULD submit the selected handoff response before unrelated
ordinary messages.

Until an authenticated message has been received at `P_A`, every new package
sent from `P_A` to this relationship MUST:

- use the responder Peer-DID long form in plaintext `from`, `skid` and `apu`;
  and
- carry the same byte-stable stored `fromPrior` whose `sub` equals that long
  form.

After confirmation, new packages omit `from_prior` and may use the canonical
short form. Already prepared exact packages are not rewritten.

## 12. Initiator transition and confirmation

When the initiator receives or recovers a handoff carrying `from_prior`, it
performs these steps in order. The entry condition is incomplete handoff
validation/binding, not merely an unknown responder DID. A known DID does not
prove that `relationship.initiatorBound` or `message.executionBound` exists.
Existing consistent evidence is reused; conflicting evidence blocks processing.

1. require `from_prior.sub` to equal plaintext `from` byte-for-byte;
2. require plaintext `from`, protected `skid` and decoded `apu` to use the same
   responder Peer-DID long form;
3. search its retained initial messages sent from the same initiator
   relationship DID for a pinned snapshot whose exact presented DID equals
   `iss`, whose authorized authentication `kid` equals the JWT `kid`, and whose
   `createdTime` equals `iat`;
4. verify the JWT signature and all claims against that exact snapshot;
5. validate protocol threading and OOB `pthid` where applicable;
6. attach the pairwise channel to the existing contact and append
   `peer.transitioned` for this contact only;
7. derive the deterministic relationship ID from the canonical pinned
   rendezvous DID and the initiator's own relationship-key fingerprint, then
   process-durably append `relationship.initiatorBound` naming the exact
   initial outbound, snapshot, initiator identity and validated handoff;
8. append or reuse `message.executionBound` for the handoff carrier under that
   relationship scope. All missing locally produced facts in steps 6–8 MUST
   commit in one process-durable `appendAll`; the event-store contract makes
   that batch all-or-nothing;
9. only after the proof and portable relationship/execution binding are
   committed, process explicit `ack` values; and
10. honor any explicit current-message ACK request in the response using an
    existing deterministic protocol response or a deterministic Empty Message
    ACK.

Missing historical evidence defers processing. Invalid proof is an integrity
or protocol failure. An imported or previously separately committed prefix is
reconciled by validating and atomically appending its missing facts; it MUST
NOT execute under a provisional observation, contact or channel scope. Reopen
rediscovers unfinished committed inbound work under `vault-events.md` section
16.1, even after pickup ACK and without mediator redelivery.
A response does not acknowledge the initial message unless its authenticated
explicit `ack` array names that wire ID.

The confirmation message is sent to `P_A`, contains no `please_ack`, and is
submission-terminal after first successful submission. Its execution scope is
the committed relationship binding above, never a provisional channel scope.
A crash after binding and before ACK-effect creation therefore reconstructs the
same confirmation effect. Duplicate response delivery re-submits the same
exact prepared confirmation package.

The responder may stop attaching `from_prior` after receiving any authenticated
message addressed to `P_A`. Delivery acknowledgment for the handoff response
still requires an explicit `ack` naming its wire ID.

## 13. Rejection and problem handling

There is no rendezvous `decline` message.

The code of the effective reject result maps to peer-visible Report Problem
code as follows:

```text
sender-did-conflict  -> e.p.estoc.sender-did-conflict
unsupported-protocol -> e.p.estoc.unsupported-initial-protocol
capacity             -> e.p.estoc.capacity
policy                -> e.p.estoc.not-accepted
not-accepted          -> e.p.estoc.not-accepted
expired               -> e.p.estoc.initial-message-expired
```

A reject may result in no response, a protocol-defined deterministic error, or
`https://didcomm.org/report-problem/2.0/problem-report` from the rendezvous DID
to the initiator relationship DID. The response:

- MAY include `ack` naming every explicitly requested and durably known ID;
- contains no `from_prior`;
- contains no `please_ack` and is submission-terminal; and
- creates no relationship DID or relationship state.

Example:

```json
{
  "id": "019b4d30-ea93-7826-baf6-e26449150367",
  "type": "https://didcomm.org/report-problem/2.0/problem-report",
  "from": "did:peer:4zQm...alice-rendezvous-short",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788443000,
  "pthid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "body": {
    "code": "e.p.estoc.not-accepted"
  }
}
```

A selected rejection response uses the candidate's exact authenticated bootstrap
channel as a non-transitioning control scope. Its binding and deterministic
response intent commit before submission. On the initiator, a no-handoff
problem report may use that same fixed bootstrap channel only after validating
the original local recipient and the peer key against the pinned initial
package's resolution evidence. It does not bind or establish a relationship,
alias peer keys, or waive any `from_prior` gate for handoff traffic. ACK lookup
still follows `vault-events.md` section 14.9 and never uses wire ID alone.

After final reject or ignore, candidate content is erased as specified in
section 9.3. Hard pre-vault rejection has no portable candidate to erase.

## 14. Retry, replacement, rollover and expiry

An initial sender uses bounded local retry. Recommended defaults are:

```text
minimum automatic retry interval = 30 seconds
exponential backoff cap = 21600 seconds
transport-attempt budget per wire ID per active runtime = 32
mandatory absolute stop = expires_time
```

The sender SHOULD use these defaults and MAY choose a slower or stricter local
policy. All retry tasks in one runtime share a wire ID's budget and count an
attempt before invoking transport, including failure and unknown outcomes.
The budget and backoff are local scheduling policy, not a portable lifetime
submission cap; restart, restore or loss of `local/` may reset accounting.

Expiry is frozen in `message.out` and MUST NOT be extended by retry or restart.
No attempt is permitted at or after expiry, or while another hold, terminal
failure or proof gate forbids it. An outcome-unknown attempt reuses the same
permitted exact package. Absence of `delivery.submitted` is not evidence that
no transport call occurred, and mediator idempotency does not count attempts.
A hard crash-persistent cap would require durable pre-call reservations and a
separate accounting contract; phase 1 does not introduce one. Another attempt
after terminal expiry requires a new initial message and wire ID.

Other rules:

- retrying one prepared package preserves identical plaintext and ciphertext;
- a permitted route change creates a new package while preserving logical
  intent;
- a new initial message with the same initiator key reuses the stable
  relationship but is a distinct application message;
- the same key under another canonical initiator DID is a conflict;
- a timely accepted candidate may deliver its deterministic response during
  that response's own lifetime; and
- duplicate initial/response delivery re-submits the same prepared response or
  ACK package.

A Peer rendezvous DID has no in-place key or route rollover. Changing the
mediator encoded in its document creates a new rendezvous DID and invalidates
old printed or cached invitations unless the old route remains available.
Changing a pairwise Peer DID route likewise requires a contact-scoped DID
rotation or continued operation of the old mediator. A stable `did:web`
rendezvous facade can publish a changed route without changing the public DID;
this is one reason to add the optional Web facade in a hosted deployment.

## 15. Phase-1 execution and deferred replication

Phase 1 permits exactly one active writable full vault runtime. It may run in a
local application or on a server. It uses ordinary Coordinate Mediation and
account-scoped Message Pickup; no `replica_id` appears in peer or mediator wire
messages.

`replica-mediation/1.0` and `vault-sync/1.0` are deferred. Their absence MUST
NOT block local vault operation, rendezvous, pairwise communication, export or
seed recovery. The local `replica_id` remains the event author so replication
can be added later without changing event envelopes.

Concurrent admission by several full replicas, origin coordination and
per-replica pickup are not phase-1 conformance claims.

## 16. Privacy, abuse, interoperability and security

A disclosed rendezvous DID is intentionally correlatable within its audience.
A reusable Peer rendezvous DID can be shared without DNS but remains linkable.
A Web facade additionally exposes DNS and hosting metadata.

Relationship DIDs are disclosed only inside encrypted DIDComm messages. They
MUST NOT appear in reusable OOB invitation plaintext or Web DID documents.

Registering rendezvous and relationship DIDs under one mediation account lets
the mediator correlate them. Separate arrangements may reduce this metadata
link, and `relationshipRoute` is therefore not required to equal the
rendezvous ingress route.

The baseline size/lifetime floor prevents undiscoverable local preferences from
silently dropping ordinary interoperable bootstrap. Abuse is instead bounded
by hard source/rendezvous rate limits, a bounded pending queue, post-admission
policy and immediate content erasure after reject/ignore.

Full reliable bootstrap conformance assumes the peer implements DIDComm v2.1
DID rotation (`from_prior`) and explicit `ack`. A non-Estoc agent may process
the standard Trust Ping or application message but fail to perform the
pairwise handoff or explicit receipt. Persistent relationship establishment
with such an agent is best-effort and outside profile 1.0; the Estoc UI MUST
surface an unconfirmed bootstrap rather than silently treating the rendezvous
DID as ordinary `writeTo`.

## 17. Required conformance cases

1. A complete bootstrap works with only a long-form `did:peer:4` invitation;
   no domain or Web DID is required.
2. An optional Web rendezvous DID enters the same processing profile.
3. No emitted message has an `https://estoc.dev/rendezvous/1.0/*` type.
4. The default initial Trust Ping has `response_requested == true` and
   `please_ack == [""]`; absent `response_requested` is interpreted as true.
5. `please_ack: []` is accepted but requests no explicit message ID.
6. Every implementation admits, at the hard-gate level, valid initial
   plaintext up to 65536 bytes and positive lifetime up to 604800 seconds.
7. Invitation-attached protocol messages are not hard-rejected merely by a
   hidden local allowlist.
8. OOB invitation ID is used as `pthid` for the resulting interaction.
9. Initiator intent precedes registration, resolution, preparation and
   submission.
10. Peer first disclosure uses the same long form in `from`, `skid` and `apu`.
11. Before unlock/recovery completes, recipient ownership is not classified.
    Afterward, only an exact known local key-agreement generation with a
    recoverable missing prerequisite remains pending without pickup ACK.
12. Safely classified hard rejection is pickup-ACKed and creates no portable
    candidate.
13. Local preference, capacity and unsupported-protocol decisions occur after
    durable `message.in`.
14. Reject and ignore erase candidate content roots while retaining skeleton
    observations and decisions.
15. A final accept remains final before handoff intent exists and after restart;
    relationship termination uses contact deletion, not another admission result.
16. A committed timely accept is not replaced by expiry or user/policy override.
    Incompatible final results, including different reject codes, are conflicts;
    final reject/ignore followed by erasure cannot later become accept.
17. Stable relationship/contact/responder-DID, relationship-scoped execution
    and effect vectors recompute from the published inputs.
18. `relationship.established` freezes one origin, long-form responder DID,
    rotation `iat`, exact compact `fromPrior` and deterministic handoff IDs.
19. `from_prior.iss` and protected `kid` use the exact pinned prior-DID form.
20. `from_prior.sub` equals plaintext `from` exactly; before confirmation both
    use responder Peer-DID long form.
21. The initiator validates `iat` against one of its retained initial-message
    `createdTime` values and verifies the matching pinned snapshot before ACK.
22. Handoff response is deterministic: Trust Ping response, deterministic
    protocol response or Empty ACK; human-authored content is ordinary later
    traffic.
23. Handoff response ACKs the triggering message and requests its own ACK with
    `please_ack: [""]`.
24. The handoff Empty example uses the pure-ACK ID derived from the committed
    logical execution identity and its own frozen effect input.
25. Handoff response intent freezes a replay deadline no later than its
    expiry; ACK stops normal retry but does not release its exact package before
    that deadline.
26. The origin candidate is bound to the deterministic relationship/wire-ID
    execution identity before the handoff effect; no observation-MID-derived
    identity is used.
27. Until confirmation, every responder package carries the same stored
    `fromPrior` and uses long-form sender spelling.
28. Rejection maps local codes to deterministic coarse problem codes and emits
    no custom decline.
29. Default local retry uses a 30-second minimum, a 21600-second backoff cap
    and 32 pre-counted transport attempts per wire ID per runtime. Restart may
    reset that local budget but never extends the mandatory frozen expiry.
30. Peer rendezvous mediator replacement requires a new DID/invitation unless
    the old route remains; Web facade route updates do not change its DID.
31. Rendezvous DIDs never enter ordinary relationship `writeTo`.
32. Phase 1 works with one active full runtime and standard account-scoped
    pickup; replica mediation and vault sync are not required.
33. A peer lacking `from_prior` or explicit ACK support remains visibly
    unconfirmed and is outside reliable-bootstrap conformance.
34. With the vault unlocked and recovery complete, a foreign recipient DID,
    a local DID with a nonexistent/wrong-purpose fragment, or a terminal
    generation is terminal wrong-recipient input and does not remain pending.
35. A configured-but-not-live exact local key-agreement generation remains
    deferred without pickup ACK; a locked or recovering vault is never
    classified as wrong-recipient merely because keys are unavailable.
36. The initiator commits `relationship.initiatorBound` and the handoff
    `message.executionBound` before generating the confirmation effect; restart
    immediately afterward derives the same execution ID.
37. Later verified peer-key rotation preserves that relationship execution
    scope and does not create a second automatic effect for the same wire ID.
38. A known responder DID with missing initiator/execution binding does not
    skip handoff recovery. Missing facts commit atomically before ACK/effects;
    a pre-resolution batch crash exposes all or none of those new facts.
39. A previously committed/imported transition prefix is completed from pinned
    evidence without minting another relationship or provisional execution ID.
40. Pickup-ACKed inbound work is recovered from portable history without
    mediator redelivery or local queues.
41. A final accept reserves a one-use invitation across crash before attachment;
    detach, deletion, merge and erasure never make it available to another
    consumer. Further initial messages for the same relationship reuse it.
42. A no-handoff rejection may ACK only its validated pinned bootstrap channel;
    such a receipt is not successful handoff or relationship establishment.
43. A final rejection and its optional response intent/binding commit atomically.
    A crash cannot expose a final decision with half its chosen response; when
    no response was committed, recovery erases candidate content without
    inventing a new optional response or revisiting admission.
44. An undecided candidate introducing a new consumer of an unavailable one-use
    invitation is finalized as reject with code `not-accepted`. An
    optional Report Problem uses `e.p.estoc.not-accepted`; no new code is added.
45. Same-consumer reuse and recovery of a committed accept do not become a new
    invitation take or overwrite the result. Only the unique valid final-result
    equivalence class is effective; conflicted or undecided candidates have
    none.
