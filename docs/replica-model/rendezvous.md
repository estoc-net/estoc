# Estoc Rendezvous and Pairwise Bootstrap Profile 1.0

Status: **draft** — a processing profile for bounded discovery and
privacy-preserving handoff from a vault-scoped rendezvous DID to a
contact-scoped `did:peer:4` relationship.

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
- `distributed-delivery/1.0`;
- `replica-mediation/1.0` when a mediator is used;
- `vault-events.md`; and
- `vault-sync/1.0` when more than one full replica is used.

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
- **Initial-message allowlist** — the exact DIDComm message types that one
  rendezvous generation accepts as bootstrap candidates.
- **Admission decision** — a durable local decision to `accept`, `reject` or
  `ignore` one bootstrap candidate. It is not a wire message.
- **Natural response** — the next response defined by the initial message's
  own application protocol.
- **Handoff response** — the first responder message for the relationship. It
  is a natural response, a Trust Ping `ping-response`, or an Empty Message ACK,
  sent from the responder relationship DID with `from_prior`.
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
- **Replica** — one writable full incarnation of a vault. A replica ID is not
  a DID and never appears in peer-visible bootstrap messages.

## 4. Invariants

1. The initiator and responder address DIDs, never replica IDs.
2. The initial message is an ordinary, allowlisted DIDComm message.
3. Trust Ping 2.0 is the default initial protocol when there is no application
   content to send.
4. There is no Estoc wire-level `accept` or `decline` message.
5. Admission is a local durable decision represented by
   `relationship.admissionDecided`.
6. An accepted bootstrap creates or reuses one deterministic relationship,
   contact and responder pairwise DID.
7. The responder's handoff response uses the relationship DID and carries a
   valid `from_prior` proving rendezvous DID to relationship DID.
8. The transition is contact-scoped. It does not globally retire or alias the
   rendezvous DID.
9. Repeated initial messages from the same authenticated initiator key to the
   same rendezvous DID reuse the same relationship.
10. Each initial message remains a separate application message and may have
    its own protocol response and thread.
11. A deterministic contact tombstone is not resurrected by another initial
    message from the same initiator key.
12. A rendezvous DID never appears in ordinary relationship `writeTo`.
13. A mediator treats rendezvous and relationship DIDs as ordinary recipient
    DIDs and stores only encrypted inner envelopes.

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
- the canonical short form is used in plaintext `to`, Routing `forward.next`,
  mediator recipient registration, and `from_prior.iss`; and
- the selected routes and keys MUST equal the long-form input document.

For an initiator or responder relationship DID, the long form MUST be used on
first disclosure. Later messages normally use the canonical short form after
the receiver has durably stored the mapping.

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
`apu` all use the same long form. After the long/short mapping is known, a
later package may use long form or short form, but all three values in that
package MUST use the same form.

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
is closed by the first accepted contact according to the vault invitation
fold.

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
- the route embedded in responder relationship DIDs;
- `initialMessageTypes`, an exact non-empty allowlist;
- admission policy `ask`, `auto` or `silent`;
- maximum initial-message lifetime; and
- optional bounded auto-admission limits.

Version 1.0 requires support for:

```text
https://didcomm.org/trust-ping/2.0/ping
```

A product MAY additionally allowlist application messages such as:

```text
https://didcomm.org/basicmessage/2.0/message
```

A message family wildcard is not allowed in the portable generation event.
A future profile may define one. Implementations may impose a stricter local
allowlist than the portable event.

A generation is **live** only when its key, document and route dependencies
validate and all selected mediated ingress routes are reconciled. A configured
but not-yet-live generation is deferred, not rejected.

## 8. Initial message profile

### 8.1 Common requirements

An initial message MUST:

- be authcrypted from an initiator relationship DID;
- be addressed to a live rendezvous DID generation;
- have an exact `type` in `initialMessageTypes`;
- use the initiator Peer DID long form for first-disclosure plaintext `from`,
  protected `skid` and decoded `apu`;
- include immutable `created_time`;
- include `expires_time` within the configured maximum lifetime;
- satisfy `created_time < expires_time`;
- include a present DIDComm `please_ack` header, normally `[]`, so the current
  message can reach an ultimate acknowledged state;
- include the invitation ID as `pthid` when it arose from OOB discovery; and
- be durably represented by `message.out` before registration, resolution,
  encryption or network submission.

The `please_ack` array does not contain an empty-string sentinel. Its presence
requests acknowledgment of the current message. Any IDs in the array name
older messages that are also being acknowledged.

An otherwise valid unexpired initial message MUST NOT be rejected solely
because its `created_time` is far from the receiver's clock. Expiration and the
configured maximum lifetime are the freshness limits.

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
  "please_ack": [],
  "body": {
    "response_requested": true
  }
}
```

For bootstrap, `response_requested` MUST be true. The default specified by
Trust Ping is therefore made explicit in the durable intent. A successful
Trust Ping demonstrates channel reachability and message-level security; it
does not by itself grant application authorization, social trust or account
privileges.

### 8.3 Content-first bootstrap

An allowlisted application message may replace Trust Ping. For example:

```json
{
  "id": "019b4d13-29d3-79f1-9af6-4c3f11d52ce6",
  "type": "https://didcomm.org/basicmessage/2.0/message",
  "from": "did:peer:4zQm...bob-short:z...bob-input-document",
  "to": ["did:peer:4zQm...alice-rendezvous-short"],
  "created_time": 1788442800,
  "expires_time": 1789047600,
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "please_ack": [],
  "body": {
    "content": "Hello"
  }
}
```

The application content is the initial protocol message. It MUST NOT be
wrapped in an Estoc rendezvous protocol message.

The selected protocol must either define a natural response or permit the
responder to send an Empty Message ACK. Since all conforming initial messages
carry `please_ack`, Empty Message is always available as the fallback.

### 8.4 Initiator preparation order

The initiator:

1. creates or selects its pairwise relationship DID `P_B`;
2. selects or creates the local contact and associates the disclosed
   rendezvous DID with it;
3. writes body and attachment blobs;
4. appends `message.out` for the Trust Ping or application message;
5. reconciles recipient registration for `P_B` so the response is reachable;
6. resolves the rendezvous DID and appends exact `peer.resolved` evidence;
7. attaches the bootstrap channel with `because == "rendezvous"`;
8. appends one exact `message.prepared`; and
9. submits it directly or through Routing 2.0.

Steps 3–4 happen with networking disabled. Registration and resolution are
retryable effects. The bootstrap-channel observations and preparation SHOULD
be one atomic batch when the backend supports it.

## 9. Responder admission

### 9.1 Deferred delivery

A delivery remains pending at the mediator, with no pickup ACK and no
`message.in`, when:

- the local key named by JWE `kid` is not yet available but may arrive through
  vault sync;
- the generation is configured but not yet live;
- required key/document/route events have not yet arrived; or
- required historical evidence is temporarily unavailable.

The replica syncs, refolds and retries. A terminal generation or permanently
invalid envelope is not deferred.

### 9.2 Hard pre-vault gate

After authenticated decryption but before writing durable application state,
the responder checks:

- recipient DID and selected generation;
- exact message type allowlist;
- authcrypt sender and Peer DID long-form evidence;
- `from`/`skid`/`apu` same-form consistency;
- required `please_ack` presence;
- Trust Ping `response_requested == true` when applicable;
- `created_time`, `expires_time` and maximum lifetime;
- body, attachment and complete-message byte limits;
- per-rendezvous and per-source rate limits;
- pending-admission ceiling; and
- raw ingress/storage ceiling.

A safely classified hard rejection:

- MUST be pickup-ACKed;
- MUST NOT append `message.in`;
- MUST NOT create a contact, relationship or response effect; and
- MAY leave only a bounded local diagnostic.

Examples include malformed input, wrong type, wrong recipient, terminal
generation, invalid first-disclosure Peer DID, missing required receipt
request, hard rate limit and hard raw-storage limit.

A `silent` generation policy also discards a valid candidate at this boundary
without a portable candidate or liveness response.

### 9.3 Durable candidate and local policy

A candidate that passes the hard gate is committed as `message.in` before this
replica ACKs mediator delivery. It is initially excluded from ordinary contact
threads until admitted.

The local decision is then represented by:

```text
relationship.admissionDecided
```

The outcome is:

```text
accept | reject | ignore
```

`ask` is the default. `auto` must be explicit and bounded. Post-admission
policy may consider relationship count, recipient quota, user approval and
organization rules.

A rejected durable candidate MAY produce a protocol-specific error or a
Report Problem 2.0 message. It does not create a relationship DID. An ignored
candidate produces no peer-visible response.

Only the fold's effective rejection may create an explicit error response. If
a Report Problem body contains stable code `C`, its automatic-effect inputs
are:

```text
handlerId  = https://estoc.dev/profiles/rendezvous/1.0
effectKind = problem-report:C
ordinal    = 0
```

The code is therefore part of the effect identity; two different bodies cannot
silently share one deterministic message ID.

A decision to accept is valid only while the initial message is unexpired. A
candidate reaching expiry before acceptance may be rejected with local code
`expired` or ignored.

Conflicting decisions for the same candidate are resolved before the first
response intent exists:

1. equal decisions are duplicates;
2. one valid user decision outranks policy observations;
3. contradictory user decisions are a visible conflict;
4. a timely policy `accept` outranks a later policy `reject(code="expired")`;
   and
5. otherwise incompatible policy decisions are a visible conflict.

Once a handoff response intent or any other relationship response has been
durably committed, later rejection does not retroactively undo it. Ending the
relationship uses normal contact deletion and DID/route retirement.

## 10. Deterministic relationship materialization

Acceptance derives stable IDs from the canonical rendezvous DID and the
authenticated initiator key, not from the initial message wire ID or type.

Purpose namespaces are derived as specified in `event-store.md` and
`vault-events.md`:

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

The responder pairwise key names are derived from
`our_relationship_did_id`. Every full replica therefore derives the same
relationship DID from the shared seed.

Acceptance materializes or reuses:

- `contact.created`;
- bootstrap and pairwise `contact.attached` edges;
- `contact.useDid`;
- responder `did.created` with role `relationship`;
- `relationship.established`; and
- the selected protocol response `message.out`.

These events SHOULD be one `appendAll` batch.

Multiple initial message IDs from the same `(rendezvous DID, peer key)` reuse
one relationship while retaining separate application messages and response
effects.

If the deterministic contact is tombstoned, another candidate from the same
peer key MUST NOT recreate it. A genuinely new relationship requires a fresh
initiator relationship key.

If one authenticated key is presented under different canonical initiator
DIDs, the relationship has a sender-DID conflict. No ordinary current remote
end is selected until the conflict is resolved by non-conflicting evidence.

## 11. Handoff response

### 11.1 Response selection

After relationship admission, the responder chooses exactly one handoff
response for the admitted initial message:

1. for Trust Ping with `response_requested != false`,
   `https://didcomm.org/trust-ping/2.0/ping-response`;
2. the natural response defined by the initial application protocol when that
   response is already due and safe to emit; or
3. `https://didcomm.org/empty/1.0/empty` when no natural response is available
   yet.

Relationship admission and business-protocol acceptance are separate. An
Empty ACK may establish the pairwise handoff while a credential, proof,
payment or other application decision remains pending.

The response is produced by the ordinary deterministic automatic-effect
machinery. There is no rendezvous-specific accept effect ID.

For Trust Ping, the deterministic effect inputs are:

```text
handlerId  = https://didcomm.org/trust-ping/2.0
effectKind = ping-response
ordinal    = 0
```

For initial-message observation MID
`ca6f6a41-454c-53ff-b827-1797156687cf`, the generic automatic-effect
functions produce this fixed vector:

```text
effectId = j0Ji1-6swFT6C0zHEv5XAE_ouM2A7p7iO707T3YcNfg
mid      = 93a1a0e9-383c-5106-a995-10234a729f70
wireId   = bfbdcb31-4ebc-5c57-bbdf-c4d82352afed
```

For the Empty Message fallback, the pure-ACK derivation in
`distributed-delivery/1.0` is used.

The handoff timing projection is deterministic across replicas:

```text
response.created_time = initial_message.created_time
response.expires_time = initial_message.expires_time + 604800
from_prior.iat         = response.created_time
```

The addition MUST fail closed on integer overflow. The seven-day response
window is independent of the initial-message admission deadline: acceptance
must be committed before the initial message expires, while a response
created by that timely acceptance may remain deliverable during its own
window.

### 11.2 Required handoff headers

The first response MUST:

- use responder relationship DID `P_A` in plaintext `from`;
- disclose `P_A` long form in plaintext `from`, protected `skid` and decoded
  `apu`;
- address initiator relationship DID `P_B`;
- preserve protocol threading;
- preserve the OOB invitation ID as `pthid` when present;
- include `ack` naming the initial message wire ID;
- include present `please_ack: []` to request handoff confirmation;
- include a byte-stable `from_prior` whose `iss` is the canonical rendezvous
  DID and whose `sub` is canonical `P_A`; and
- be committed as `message.out` before recipient registration, resolution,
  encryption or submission.

The `from_prior` protected `kid` names the authentication method in the exact
initial-message-bound rendezvous document. Its `iat` is the stable handoff
time defined by the automatic response profile; all replicas preparing the
same response must use the same value.

Trust Ping response example:

```json
{
  "id": "bfbdcb31-4ebc-5c57-bbdf-c4d82352afed",
  "type": "https://didcomm.org/trust-ping/2.0/ping-response",
  "from": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "from_prior": "eyJ...",
  "please_ack": [],
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "body": {}
}
```

Empty fallback example:

```json
{
  "id": "5627527e-2820-5935-9d91-7e0181838aa9",
  "type": "https://didcomm.org/empty/1.0/empty",
  "from": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
  "thid": "019b4d13-29d3-79f1-9af6-4c3f11d52ce6",
  "pthid": "019b4d01-0e42-775e-8abe-173d777fcb3a",
  "from_prior": "eyJ...",
  "please_ack": [],
  "ack": ["019b4d13-29d3-79f1-9af6-4c3f11d52ce6"],
  "body": {}
}
```

### 11.3 Registration and submission order

The responder:

1. appends the acceptance, relationship state and response `message.out`;
2. reconciles recipient registration for canonical short-form `P_A`;
3. prepares the exact response with long-form first disclosure and
   `from_prior`; and
4. submits it.

Any full replica may complete steps 2–4. Intent always precedes effects.

### 11.4 Messages before handoff confirmation

The responder SHOULD submit the selected handoff response before unrelated
ordinary messages. Correctness does not depend on ordering, however.

Until an authenticated message has been received at `P_A`, every responder
package sent from `P_A` to this relationship MUST carry the same byte-stable
`from_prior`. Thus an ordinary message that overtakes the selected response is
still attributable and can establish the transition.

The response remains receipt-required until its explicit ACK arrives or
another terminal state applies.

## 12. Initiator transition and confirmation

When the initiator receives a message from an unknown responder DID carrying
`from_prior`, it performs these steps in order:

1. locate the exact initial-message-bound rendezvous document snapshot used by
   the relevant initial message;
2. validate message addressing and responder Peer DID long form;
3. validate `from_prior` signature, `iss`, `sub`, `kid` and `iat` against that
   snapshot;
4. validate protocol threading and OOB `pthid` where applicable;
5. only after those checks, process any `ack` values;
6. attach the pairwise channel to the existing contact;
7. append `peer.transitioned` for this contact only; and
8. honor the response's `please_ack` using the next natural outbound message
   or a deterministic Empty Message ACK addressed to `P_A`.

Missing historical evidence defers processing. Invalid proof is an integrity
or protocol failure. A response does not acknowledge the initial message
unless its authenticated explicit `ack` array names that wire ID.

The initiator's handoff-confirmation ACK:

- is sent to `P_A`;
- contains no `please_ack` header;
- is submission-terminal after first successful submission; and
- is re-submitted as the same exact prepared package when the response is
  delivered again.

The responder may stop attaching `from_prior` after receiving any authenticated
message addressed to `P_A`. Delivery acknowledgment for the handoff response
still requires an explicit `ack` naming its wire ID.

## 13. Rejection and problem handling

There is no rendezvous `decline` message.

A local `reject` decision may result in:

- no peer-visible response;
- a protocol-specific error response; or
- `https://didcomm.org/report-problem/2.0/problem-report` from the rendezvous
  DID to the initiator relationship DID.

An explicit rejection response SHOULD:

- use a coarse non-sensitive code;
- include `ack` naming the initial message when honoring its `please_ack`;
- contain no `from_prior`;
- contain no `please_ack`, so it is submission-terminal; and
- create no relationship DID or relationship state.

A Report Problem message begins a child thread. Its `pthid` MUST equal the
triggering initial message's protocol `thid` (or that message's `id` when its
`thid` is absent). It does not copy the OOB invitation ID into its own `pthid`;
the OOB parent remains discoverable through the triggering initial message.
The problem report MAY omit `thid`, in which case its own `id` is its thread
identifier.

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

Hard pre-vault rejection and `silent` policy do not emit this response.

A valid explicit rejection may complete the initiator's delivery state while
still indicating that the application or relationship was rejected.

## 14. Retry, replacement, rollover and expiry

- Retrying one prepared package preserves identical plaintext and ciphertext.
- A permitted route change creates a new package while preserving the same
  logical message intent.
- A new initial message with a new wire ID and the same initiator key reuses
  the stable relationship but is a distinct application message.
- The same key under another canonical initiator DID is a sender-DID conflict.
- An expired initial message records terminal delivery failure and cannot be
  accepted afterward.
- An acceptance committed while the initial message was live may still produce
  and deliver its response while that response remains unexpired.
- Duplicate delivery of an initial message or handoff response re-submits the
  same previously prepared deterministic response or ACK package.

A Peer rendezvous DID has no in-place key rollover in version 1.0. Changing
its keys or embedded route creates a new Peer rendezvous DID and new
disclosure.

A Web rendezvous DID may roll generations. The generation event, document
revision, key and route dependencies MUST be durable and synchronized before
the revision is published and considered live.

Private keys and historical document evidence needed for queued packages and
`from_prior` verification remain available through at least:

```text
maximum initial-message lifetime
+ mediator retention
+ delivery safety margin
```

Emergency compromise recovery may intentionally break this availability.

## 15. Replica and deployment behavior

A process holding the seed may run as an ordinary full replica locally or on
a server. It has one `replica_id`, participates in sync and receives the same
mediator deliveries as every other active replica.

No host identity appears in bootstrap messages or portable relationship
semantics. A Peer rendezvous DID belongs to the vault, not the application
that displays its QR. A Web rendezvous DID belongs to the vault, not the
process serving `did.json`.

Two replicas may admit and process the same candidate concurrently. Stable
relationship IDs, automatic effect IDs, message IDs and wire IDs make their
portable output converge. A lease may reduce duplicate work but is not
required for correctness.

A thin client without the seed is not a replica and does not register for
mediator pickup.

## 16. Privacy, abuse and security

A disclosed rendezvous DID is intentionally correlatable within its audience.
A reusable Peer rendezvous DID can be shared without DNS but remains linkable.
A Web facade additionally exposes DNS and hosting metadata.

Relationship DIDs are disclosed only inside encrypted DIDComm messages. They
MUST NOT appear in reusable OOB invitation plaintext or Web DID documents.

Registering rendezvous and relationship DIDs under one mediation account lets
the mediator correlate them. A vault may use separate arrangements when this
metadata link is unacceptable.

Every broadly distributed rendezvous address creates responder cost and a
liveness oracle. Therefore:

- `ask` is the default admission policy;
- `auto` is explicit and bounded;
- `silent` emits no response and no portable candidate;
- hard pre-vault and post-admission limits are both mandatory;
- explicit problem detail is coarse; and
- relationship creation and response preparation occur only after an
  effective durable acceptance.

The mediator never receives relationship IDs, contact IDs, policy decisions,
replica labels or application plaintext.

A valid `from_prior` proves that the controller authorized by the exact pinned
rendezvous document authorized one pairwise DID in this contact. It does not
globally link all pairwise DIDs controlled by the vault.

## 17. Required conformance cases

1. A complete bootstrap works with only a long-form `did:peer:4` invitation;
   no domain or Web DID is required.
2. An optional Web rendezvous DID enters the same processing profile.
3. No emitted message has an `https://estoc.dev/rendezvous/1.0/*` type.
4. The default no-content initial message is Trust Ping 2.0 `ping` with
   `response_requested == true`.
5. An allowlisted application message can be the first message without being
   wrapped in another protocol.
6. Every conforming initial message has a present `please_ack` header and a
   finite `expires_time` within the generation maximum.
7. OOB invitation ID is used as `pthid` for the resulting interaction.
8. The initiator commits `message.out` before registration, resolution,
   preparation or submission.
9. The initiator relationship DID is registered before first submission.
10. Peer DID first disclosure uses the same long-form spelling in plaintext
    `from`, protected `skid` and decoded `apu`.
11. Unknown key or configured-but-not-live generation remains unacknowledged
    at the mediator and is re-evaluated after sync/refold.
12. Every safely classified hard pre-vault rejection is pickup-ACKed without
    `message.in` and leaves at most bounded local diagnostics.
13. A candidate passing the hard gate is durably stored before pickup ACK.
14. `ask` is default, `auto` is explicit and bounded, and `silent` creates no
    portable candidate or liveness response.
15. `relationship.admissionDecided` is a local decision, not a wire protocol
    message.
16. Two initial wire IDs from one `(rendezvous DID, initiator key)` reuse one
    relationship/contact/responder DID and remain separate application
    messages.
17. A tombstoned deterministic contact is not recreated; a fresh initiator key
    produces another relationship.
18. One initiator key under another canonical DID is a sender-DID conflict.
19. An accepted Trust Ping produces standard `ping-response`, not a custom
    accept message.
20. An accepted protocol with no natural response uses an Empty Message ACK.
21. The handoff response contains explicit `ack`, present `please_ack: []`,
    responder long-form Peer DID and valid `from_prior`.
22. Response intent precedes responder pairwise recipient registration, which
    precedes submission.
23. The initiator verifies `from_prior` against pinned
    initial-message-bound evidence before applying response ACK or appending `peer.transitioned`.
24. Missing evidence defers processing; invalid proof rejects it.
25. The initiator confirms handoff with a natural outbound message or pure ACK
    addressed to the new pairwise DID.
26. Duplicate response delivery re-submits the same exact confirmation ACK.
27. Until confirmation, every responder message from the new pairwise DID
    carries the same byte-stable `from_prior`.
28. A local rejection emits no custom decline. An optional problem report has
    no `from_prior` and no `please_ack`; its `pthid` is the triggering protocol
    thread, not the OOB invitation.
29. Rendezvous DIDs never enter ordinary relationship `writeTo`.
30. Adding or removing a server replica changes delivery/sync state only, not
    rendezvous or relationship DIDs.
