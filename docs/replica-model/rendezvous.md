# rendezvous/1.0

Status: **draft** — public discovery, admission and privacy-preserving handoff
from one vault-scoped `did:web` rendezvous DID to one contact-scoped
`did:peer:4` relationship.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

## 1. What it is for

A stable public identifier is useful for discovery, but it is a poor
identifier for an ongoing private relationship. Estoc therefore separates:

- a **rendezvous DID**, normally a `did:web`, which is public, reusable and
  resolves to a bootstrap delivery route; and
- a **relationship DID**, a `did:peer:4`, which is created for one
  relationship and used after bootstrap.

The rendezvous DID discovers a vault. It does not identify a replica and it
is not the address used for ordinary relationship traffic.

```text
public rendezvous DID W_A
        │
        │ request from Bob's relationship DID P_B
        ▼
Alice's vault
        │
        │ accept from Alice's relationship DID P_A
        │ with from_prior: W_A -> P_A
        ▼
P_A <--------------------------> P_B
       later relationship traffic
```

The public request and later pairwise traffic may use the same mediator and
mediation account. `replica-mediation/1.0` applies the same fan-out machinery
to both recipient DIDs.

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Out-of-Band 2.0 (`https://didcomm.org/out-of-band/2.0`);
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Peer DID Method numalgo 4;
- `distributed-delivery/1.0`;
- `replica-mediation/1.0` when a mediator is used;
- the vault event semantics in `vault-events.md`; and
- this protocol family: `https://estoc.dev/rendezvous/1.0`.

## 3. Terms

- **Rendezvous DID** — a vault-scoped, publicly discoverable DID with role
  `rendezvous`. Version 1.0 profiles `did:web`.
- **Relationship DID** — a vault-scoped DID with role `relationship`, created
  for one relationship. Version 1.0 requires `did:peer:4`.
- **Long form** — the self-resolving `did:peer:4` value that contains its
  encoded input document.
- **Short form** — the hash-only `did:peer:4` value derived from the long
  form. It is the canonical vault and mediator recipient identifier after
  first disclosure.
- **Initiator** — the party that resolves or otherwise learns the rendezvous
  DID and sends `request`.
- **Responder** — the vault controlling the rendezvous DID.
- **Rendezvous generation** — an immutable binding between one public DID key
  generation, one published document revision, accepted ingress routes,
  relationship route and request-admission policy.
- **Bootstrap channel** — the authenticated channel from the initiator's
  relationship key to the responder public key used for `request`.
- **Relationship ID** — the responder's deterministic local entity ID for
  the pair `(rendezvous DID, authenticated initiator key)`. It is never sent
  to the peer.
- **Request decision** — a durable `accept`, `decline` or `ignore` decision
  for one request wire ID.
- **Handoff confirmation** — one responder `accept` has received an
  authenticated ultimate ACK from the initiator. In vault state this is a
  `delivery.acknowledged` observation for an accept effect belonging to the
  relationship.
- **Replica** — one writable full incarnation of a vault. A replica ID is not
  a DID and never appears in this protocol's application messages.

## 4. Invariants

1. A sender addresses a rendezvous DID or relationship DID, never a replica
   ID.
2. The first `request` is encrypted to the rendezvous DID before mediation.
3. A successful `accept` is sent from a newly created relationship DID.
4. `accept.from_prior` proves a transition from the rendezvous DID to the
   relationship DID presented in `accept.from`.
5. The transition is scoped to one contact. It does not retire the public DID
   or globally replace it for unrelated peers.
6. Repeated request messages from the same authenticated initiator key to the
   same public DID reuse one responder relationship, contact and pairwise DID.
7. Each request wire ID has its own threaded `accept` or `decline` effect and
   explicit DIDComm acknowledgment.
8. Several replicas processing the same request MUST derive equal semantic
   state and equal automatic message IDs.
9. A deleted deterministic contact is never resurrected by another request
   from the same initiator key. Reconnection requires a fresh initiator
   relationship key.
10. A mediator treats rendezvous and relationship DIDs as ordinary recipient
    DIDs and stores only encrypted inner envelopes.

## 5. DID profiles and resolution evidence

### 5.1 Public `did:web` profile

A version-1.0 rendezvous DID MUST:

- use `did:web`;
- expose exactly one selected `keyAgreement` method for new rendezvous
  requests;
- expose at least one `authentication` method capable of signing
  `from_prior`;
- publish at least one `DIDCommMessaging` service; and
- be controlled by seed-derived key names represented in the vault.

For public key generation integer `N`, this profile fixes the DID URL
fragments:

```text
#authentication-N
#key-agreement-N
```

The full IDs MUST therefore be exactly:

```text
<rendezvous DID>#authentication-<N>
<rendezvous DID>#key-agreement-<N>
```

A conforming document for generation 0 resembles:

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
  "authentication": [
    "did:web:alice.example#authentication-0"
  ],
  "keyAgreement": [
    "did:web:alice.example#key-agreement-0"
  ],
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

The document bytes selected by the responder are RFC 8785 canonical JSON.
The initiator MUST durably retain the exact document bytes, their unpadded
base64url SHA-256 hash, the selected authentication `kid` and the selected
key-agreement `kid` before it submits `request`. This is the **request-bound
resolution snapshot**.

The initiator later validates `from_prior` against this exact snapshot, not
against whatever document happens to resolve when `accept` arrives. A current
network resolution MAY recover a missing snapshot only when its canonical
hash equals the request-bound hash. Inability to recover the snapshot is a
deferred verification state, not proof that the acceptance is invalid.

A direct HTTPS endpoint MAY also be present. It is another route to the same
vault-scoped DID and MUST NOT expose a replica ID.

### 5.2 Relationship `did:peer:4` profile

Every relationship DID in version 1.0 MUST use Peer DID numalgo 4 and MUST be
stored locally as both:

- its canonical short form; and
- its corresponding long form.

The long form MUST be used whenever that DID is first disclosed to a peer.
This requirement applies at both DIDComm layers:

- `request.from` and the authcrypt sender identifier for the initiator;
- `accept.from` and the authcrypt sender identifier for the responder; and
- any other first package that discloses a relationship DID.

For an authcrypted first-disclosure package:

1. the JWE protected `skid`, when present, MUST be a DID URL rooted in the
   exact long-form `did:peer:4` presented by plaintext `from`;
2. protected `apu` MUST be unpadded base64url of the UTF-8 bytes of that same
   long-form `skid`;
3. when `skid` is omitted, decoding `apu` MUST still recover that long-form
   sender DID URL; and
4. the key fragment MUST resolve to a key-agreement method in the decoded
   long-form input document.

After decoding, validating and durably storing the long form, the receiver
stores its short form and treats later long-form and canonical-short-form
sender DID URLs as equivalent presentations of the same relationship DID.
Later authcrypt packages MAY therefore use either form in `skid`/decoded
`apu`, provided the receiver already knows the exact mapping and plaintext
`from` is consistent with the same DID identity.

The short form is used for mediator recipient registration and ordinary
post-bootstrap traffic. A short form received before its corresponding long
form or decoded input document is known is unresolved and MUST NOT be used to
decrypt, authenticate or create a relationship.

## 6. Out-of-band discovery

A public page or QR code MAY expose an Out-of-Band 2.0 invitation whose
`from` is the rendezvous DID:

```json
{
  "id": "019b4d10-8eb8-7cb7-8a25-d51376ee3701",
  "type": "https://didcomm.org/out-of-band/2.0/invitation",
  "from": "did:web:alice.example",
  "body": {
    "goal_code": "establish-relationship",
    "goal": "Write to Alice",
    "accept": ["didcomm/v2"]
  }
}
```

The invitation MUST NOT contain a final relationship DID. Every identifier in
it is public. Private profile data is sent only after an encrypted channel
exists. The invitation ID is parent-thread metadata, not a relationship ID.

## 7. Initiator preparation

Before any network effect, the initiator MUST durably:

1. create or select a contact containing the responder rendezvous DID;
2. create one local `did:peer:4` relationship DID dedicated to this
   prospective relationship;
3. associate that local DID with the contact;
4. append `message.out` for `request`, including immutable `createdTime`,
   `expiresTime`, `pleaseAck == [""]` and the logical body; and
5. keep the same local relationship DID and key for retries and replacement
   request messages belonging to the same intended relationship.

The initiator may perform these steps offline because the logical request body
contains no resolution-dependent document hash or `kid`. The exact public
snapshot and recipient key are package evidence recorded by
`message.prepared`, not logical application content. A retry of one wire ID
reuses the same request intent. If the user creates a replacement request
after expiry, it uses a new wire ID but SHOULD reuse the same initiator
relationship DID unless the prior contact was deleted.

Before the first request submission, but only after `message.out` exists, a
replica MUST make the initiator relationship DID reachable:

1. for every selected mediated route, reconcile registration of the canonical
   short-form initiator relationship DID and append `did.routeRegistered`
   after success; and
2. for a selected direct route, verify that the advertised endpoint can route
   the canonical short-form DID to the same vault runtime.

This registration is a retryable pre-submission effect. Failure leaves the
offline request intent pending; it never causes the intent to be lost or
recreated.

Before preparing the first package, a replica resolves the rendezvous DID and
MUST durably append, preferably in one batch:

- the exact `peer.resolved` snapshot including document bytes and hash;
- `channel.firstSeen` for the bootstrap channel;
- `contact.attached` for that channel with `because == "rendezvous"`; and
- `message.prepared`.

Attaching the bootstrap channel at the initiator allows a `decline` or
request-triggered problem report sent from the public DID to be attributed to
the correct contact.

The implementation MUST NOT replace the pinned public key generation while
preparing or retrying the same request wire ID. A different generation
requires a new request wire ID.

## 8. `request`

Message type:

```text
https://estoc.dev/rendezvous/1.0/request
```

Example plaintext before encryption:

```json
{
  "id": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "type": "https://estoc.dev/rendezvous/1.0/request",
  "from": "did:peer:4zQm...bob-short:z...bob-input-document",
  "to": ["did:web:alice.example"],
  "created_time": 1788442800,
  "expires_time": 1789047600,
  "pthid": "019b4d10-8eb8-7cb7-8a25-d51376ee3701",
  "please_ack": [""],
  "body": {
    "goal_code": "establish-relationship",
    "goal": "Write to Alice"
  }
}
```

Requirements:

- `from` is the initiator relationship DID in long form;
- `to` contains exactly the responder rendezvous DID;
- the message is authcrypted to the key-agreement `kid` from the initiator's
  durable request-bound resolution snapshot, with exactly one ultimate JWE
  recipient entry;
- first disclosure at the authcrypt layer follows section 5.2: protected
  `skid`, when present, is rooted in the exact long-form initiator DID and
  protected `apu` encodes that same long-form sender DID URL;
- the protected recipient `kid` maps to exactly one configured rendezvous
  generation at the responder;
- the initiator's `message.prepared.peerResolution` names the exact snapshot
  used for this package; the snapshot is local durable evidence and is not
  duplicated in the application body;
- `created_time` and `expires_time` are REQUIRED;
- `created_time < expires_time`;
- `expires_time - created_time` MUST NOT exceed 604800 seconds;
- the responder checks that current time is before `expires_time`, but MUST
  NOT reject solely because `created_time` lies outside a clock-skew window;
- `goal_code` is `establish-relationship`;
- `pthid` equals the OOB invitation ID when applicable; and
- `please_ack` contains the empty string.

The request's `created_time` is its durable intent time and the deterministic
rotation-context time used by a later `from_prior`. It is not a freshness
proof. `expires_time` and the maximum lifetime bound provide freshness.

A preparing or retrying sender that observes `now >= expires_time` MUST NOT
submit another package. It records a non-retryable, message-scoped
`delivery.failed` with code `expired` and requires a new request wire ID for
another attempt.

## 9. Admission, deferral and request decisions

Receiving a mediator delivery is not sufficient to admit it to the portable
vault.

### 9.1 Undecryptable, unknown or not-yet-live generation

If the ultimate JWE recipient `kid` does not map to locally available secret
material and exactly one configured rendezvous generation, the replica MUST:

- retain the mediator delivery unacknowledged;
- record only bounded local diagnostic/deferred state;
- run vault-sync and fold reconciliation; and
- retry decryption after relevant events or key material become available.

The same rule applies when the key maps to a configured generation that is
not yet **live**, but may still become live after document publication or
route-registration observations arrive. The replica MUST re-evaluate the
delivery whenever the relevant fold changes.

It MUST NOT append `message.in`, create a contact, create a relationship or
send a pickup ACK for ciphertext it cannot decrypt and validate, or for a
generation whose eligibility is still deferred.

A generation is live only when:

- its selected document revision is durably present;
- the exact revision is published and verified;
- every selected mediated ingress route is registered;
- current time has not passed its `acceptUntil`; and
- the protected request recipient `kid` exactly equals the generation's
  normative key-agreement fragment.

A generation that is terminally retired, whose `acceptUntil` has passed, or
whose selected publication can no longer become valid is not deferred. After
safe decryption and validation, the implementation applies the pre-vault
discard/decline rules below.

All generations of one public DID whose request-acceptance windows overlap
MUST use the same `relationshipRoute`. Changing that route is activated only
after older generations can no longer yield an accepted first relationship.
An already established relationship reuses its existing responder pairwise
DID and bound route. Which request/generation supplied its canonical origin is
derived by the fold in section 10; it is not an immutable field that one
replica may race to choose.

### 9.2 Pre-vault admission

After authenticated decryption and closed-profile validation, but before
writing `message.in`, the receiver MUST run a bounded admission gate.

A public rendezvous recipient accepts only:

```text
https://estoc.dev/rendezvous/1.0/request
```

as durable application input. An ordinary application message, pure ACK,
unrelated protocol message, malformed request, wrong `to`, invalid first
disclosure, request for a terminal generation, or request exceeding a hard
per-source/per-account admission bound MUST be discarded before
`message.in`. The receiver MAY retain a bounded local diagnostic. It MUST ACK
the mediator delivery after it has safely classified the bytes so a poison
message cannot block the replica queue. It MUST NOT honor application
`please_ack`, create a contact or produce an automatic relationship effect for
such discarded input.

The same pre-vault discard is permitted for `silent` policy and for load
shedding when a configured hard bound is already exhausted. This exception is
deliberate: public rendezvous input does not gain permanent vault-storage
rights merely by being validly encrypted to a public key.

Requests that may be shown to a user, automatically accepted, or explicitly
declined are admitted only after all of these checks pass:

- the generation is live;
- the request is currently unexpired and its lifetime is within the maximum;
- the authcrypt sender DID/key and long-form evidence satisfy section 5.2;
- the public recipient DID and generation match exactly;
- pending-request, active-relationship, recipient-registration and portable
  storage limits have available capacity; and
- no tombstone or stable-relationship sender-DID conflict already makes the
  request ineligible.

For an admitted request the receiver durably appends `message.in` before
pickup ACK. The `ask` UI and all later decisions operate on that durable
message.

### 9.3 Admission policy and decision time

Every generation has one immutable request policy:

- `ask` — expose an admitted request to a user; do not create relationship
  state until an explicit durable decision exists;
- `auto` — accept admitted requests automatically, subject to configured
  rate, relationship, recipient and storage limits; or
- `silent` — persist no unknown request and emit no liveness response.

Implementations MUST default public rendezvous generations to `ask`.
`auto` is explicit opt-in and MUST have bounded rate and resource policy.

An accept, decline or explicit ignore is recorded by
`rendezvous.requestDecided`. The event records whether the decision came from
`user` or `policy`. A user decision outranks conflicting policy decisions;
two conflicting user decisions remain a visible decision conflict.

An `accept` decision is valid only when committed while:

```text
decision_time < request.expires_time
```

After request expiry the only valid new decisions are:

- `decline` with stable code `expired`, when its deterministic response is
  still unexpired and policy permits a response; or
- `ignore`.

A late user choice MUST NOT create a relationship or an `accept` intent.
No contact, relationship DID, recipient registration or response is created
before the applicable durable decision.

## 10. Deterministic relationship and response materialization

Let:

- `request_mid` be the deterministic inbound observation MID;
- `request_wire_id` be the request's DIDComm `id`;
- `public_did` be the exact rendezvous DID in `to`;
- `peer_key` be the canonical fingerprint of the authenticated initiator
  sender key;
- `initiator_did` be the canonical short form obtained from the validated
  long-form sender DID; and
- `generation_id` be the matching live rendezvous generation.

For these example inputs:

```text
public_did = did:web:alice.example
peer_key = k3j9n0m4x6q2w7c8v5p1d8s0fa
request_wire_id = 019b4d12-090a-7c3b-92f7-ac2c51f50db4
```

The stable relationship material is independent of request wire ID:

```text
relationship_id = UUIDv5(
  cfb3704a-cae5-56f9-a3e6-d73cf8246646,
  RFC8785(["v1", public_did, peer_key])
)

our_relationship_did_id = UUIDv5(
  50386028-0062-554d-9f0a-a5a21d300b56,
  RFC8785(["v1", relationship_id, "ours"])
)

contact_id = UUIDv5(
  da33b3a9-0360-5acf-a089-3ceb1fd2ee6b,
  RFC8785(["v1", relationship_id])
)
```

Each request gets its own threaded acceptance or decline effect:

```text
accept_effect_id = base64url(
  SHA-256(
    UTF8("estoc/rendezvous/1.0/accept\0") ||
    UTF8(relationship_id) || 0x00 ||
    UTF8(request_wire_id)
  )
)

decline_effect_id = base64url(
  SHA-256(
    UTF8("estoc/rendezvous/1.0/decline\0") ||
    UTF8(public_did) || 0x00 ||
    UTF8(peer_key) || 0x00 ||
    UTF8(request_wire_id)
  )
)
```

Automatic message `mid` and wire IDs derive from the effect ID under
`vault-events.md`. The response intent timestamps are also deterministic:

```text
response.created_time = request.created_time
response.expires_time = request.expires_time + 604800
```

The addition MUST fail closed on integer overflow. Version 1.0 uses the fixed
seven-day response window so independently prepared accept/decline intents
produce equal intent hashes.

Exact test-vector outputs are:

```text
request_mid = d770e714-b7f7-5c20-9c8a-d86eeb10a254
relationship_id = e10fc031-4d71-5295-9504-cf50a893ff97
our_relationship_did_id = 4275e88e-2a9d-5b5f-8346-f17ef35b71c5
contact_id = 34fdcc08-33e7-5268-a850-995c581f7cd1
accept_effect_id = RRNYwQN_gicvNmfYbFV3rGXlaJR3POmPq-NX6lFd0cc
accept_mid = 33ef3a2e-9b98-5ae2-96eb-b19aea69beaa
accept_wire_id = 5013ed47-b7c4-539a-92dc-2170b7bf4d99
decline_effect_id = 7_sQY2kwRiLWSWXRmzBCNVrnYJ84IKCpmWegM-1Tdk0
decline_mid = f1f85bc6-f4ba-5683-8dd1-664a5c30d570
decline_wire_id = f6b3570e-158a-53b9-812a-009dce492306
```

Repeated eligible requests from the same `(public_did, peer_key)` reuse the
same relationship, contact and responder pairwise DID, but each request gets
a response whose `thid` and `ack` name that request wire ID.

The canonical initiator DID for the stable relationship is not chosen by
whichever replica writes first. Every accepted `rendezvous.requestDecided`
records the validated canonical initiator DID, long form, request time,
generation and wire ID. The fold orders valid accepted requests by:

```text
(request.created_time, request.wire_id, generation_id)
```

and derives `originRequest`, `originGeneration` and `theirDid` from the
earliest entry after user-decision precedence is applied. These are fold
outputs, not immutable fields of `relationship.established`.

Reuse of one authenticated `peer_key` under another canonical Peer DID is a
sender-DID conflict, even though it would derive the same relationship ID.
Once one canonical initiator DID exists, a request presenting another DID
MUST NOT change it or be accepted automatically. Except under `silent`
policy, the responder declines that request with code
`sender-did-conflict`. If concurrent replicas already emitted conflicting
accept decisions before synchronization, the relationship fold becomes
conflicted, ordinary traffic is suspended, and a user decision must select
one request and decline the others.

If `contact_id` has a live `contact.deleted` tombstone, the responder MUST NOT
recreate or accept it. The request may be declined or ignored according to
policy. A later genuine reconnection MUST use a fresh initiator relationship
DID and sender key, producing another `peer_key` and relationship ID.

The responder creates `relationship.established` and the deterministic
contact once for the stable relationship. The stable event contains no
request-specific generation or initiator-DID winner. It creates
`rendezvous.requestDecided` once per request. Equal deterministic event
payloads from several replicas are duplicates; unresolved conflicting values
suppress automatic responses and ordinary relationship traffic.

## 11. `accept`

Message type:

```text
https://estoc.dev/rendezvous/1.0/accept
```

Example plaintext before encryption:

```json
{
  "id": "5013ed47-b7c4-539a-92dc-2170b7bf4d99",
  "type": "https://estoc.dev/rendezvous/1.0/accept",
  "from": "did:peer:4zQm...alice-short:z...alice-input-document",
  "from_prior": "eyJ...",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "please_ack": [""],
  "body": {
    "accepted": true,
    "relationship_did": "did:peer:4zQm...alice-short"
  }
}
```

The compact `from_prior` JWS uses exactly this protected header shape:

```json
{
  "alg": "EdDSA",
  "kid": "did:web:alice.example#authentication-0",
  "typ": "JWT"
}
```

and exactly this claim shape:

```json
{
  "iat": 1788442800,
  "iss": "did:web:alice.example",
  "sub": "did:peer:4zQm...alice-short:z...alice-input-document"
}
```

No unprotected JWS header and no additional protected-header or claim member is
permitted in version 1.0.

Requirements:

- the accept decision was durably committed before the request's
  `expires_time`;
- `from` is the responder relationship DID in long form on first disclosure;
- the authcrypt `skid`/decoded `apu` first-disclosure values are rooted in that
  same exact long-form DID under section 5.2;
- `body.relationship_did` is its canonical short form;
- `to` contains the canonical initiator relationship DID learned from this
  request, and that DID equals the current non-conflicted `theirDid` derived
  for the stable relationship;
- `thid` equals the request wire ID;
- `ack` contains the request wire ID;
- `please_ack` contains the empty string;
- `from_prior` is REQUIRED;
- its protected `kid` exactly equals the request-bound public
  `authentication_kid`;
- its protected `typ` is `JWT` and `alg` is `EdDSA`;
- its claims have `iss` equal to the rendezvous DID, `sub` equal to the exact
  long-form `from`, and `iat` equal to the request's durable `created_time`;
  and
- its signature verifies under the authentication method in the initiator's
  exact request-bound document snapshot.

Version 1.0 defines the contact-scoped transition epoch as the request's
durable `created_time`. The exact protected header and claims above are
encoded as RFC 8785 canonical JSON, then as unpadded base64url and signed with
deterministic EdDSA. Every replica therefore derives the same `from_prior`
bytes.

The responder MUST append the deterministic `message.out` for `accept` before
performing recipient registration, DID resolution, encryption or submission.
After intent commit, any replica may reconcile the responder pairwise DID's
canonical short form on its selected mediated route. `message.prepared` and
network submission are allowed only after that registration succeeds. This
preserves the rule that durable intent precedes every external effect while
still making the responder reachable for the initiator's ACK.

The `ack` header explicitly completes the initiator's durable request
outbound. Estoc does not rely on an implicit threaded-response ACK for
`delivery.acknowledged`.

## 12. Initiator transition and handoff confirmation

After durably storing an `accept` observation, the initiator MUST process it
in this order:

1. locate the exact outbound request and its request-bound resolution
   snapshot;
2. verify the complete package addressing, the responder's long-form
   `did:peer:4`, and `from_prior` against that snapshot;
3. verify that `to`, `thid`, response expiry and canonical initiator DID are
   consistent with the original request;
4. only after steps 1–3 succeed, apply `accept.ack` to the request's delivery
   state;
5. attach the new authenticated pairwise channel to the requesting contact;
6. append contact-scoped `peer.transitioned` from the public DID to the
   canonical responder relationship DID; and
7. submit the deterministic pure ACK or a natural relationship message whose
   `ack` includes the accept wire ID.

The order is normative. An `ack` array in an acceptance whose `from_prior`,
long-form DID or addressing has not validated MUST NOT acknowledge the
request.

If exact historical resolution evidence is temporarily unavailable, the
acceptance remains durably stored in a **deferred** state. It is not treated
as invalid, no request acknowledgment or `peer.transitioned` is appended, and
no ultimate ACK of `accept` is sent. The replica retries after sync or
snapshot recovery. Its mediator delivery may already be pickup-ACKed because
the message bytes are durable; the responder's end-to-end retry remains
active.

Request expiry ends initiator retry and forbids the responder from creating a
new accept decision, but it does not prove that an already-created accept was
not delayed in transit. Therefore a cryptographically valid accept whose own
`expires_time` is still in the future MAY be processed after the original
request expiry. The request becomes `acknowledged` with a derived `late`
indicator, retry remains stopped, and the contact transition proceeds. An
accept whose own expiry has passed has no transition or ACK side effect.

For one request thread, a valid accept with valid `from_prior` takes
precedence over every decline, regardless of arrival order. A decline ends
only that request attempt while no valid accept is known; it does not
tombstone the contact, pairwise DID or stable relationship.

The transition affects only the named contact. The public DID stays active
for unrelated initiators.

Before handoff confirmation, the responder MUST NOT prepare or submit an
ordinary application message from the new relationship DID. Only the
request-specific `accept` packages, each carrying their own byte-stable
`from_prior`, are eligible. A user may queue ordinary content locally, but
`writeTo` reports the relationship as pending and the outbox defers package
preparation.

Handoff is confirmed only by an authenticated message from the initiator
relationship DID that both names an accept wire ID in `ack` and is either:

- the conforming `empty/1.0` pure ACK; or
- an ordinary relationship message that is valid on the newly attached
  channel.

A decline, problem report, public-DID message or message from another channel
may acknowledge transport delivery but MUST NOT confirm the pairwise
handoff. After confirmation, ordinary traffic may use the relationship DID
without bootstrap `from_prior`.

## 13. `decline` and problem handling

A responder that explicitly declines an admitted request uses:

```text
https://estoc.dev/rendezvous/1.0/decline
```

Example:

```json
{
  "id": "f6b3570e-158a-53b9-812a-009dce492306",
  "type": "https://estoc.dev/rendezvous/1.0/decline",
  "from": "did:web:alice.example",
  "to": ["did:peer:4zQm...bob-short"],
  "created_time": 1788442800,
  "expires_time": 1789652400,
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "ack": ["019b4d12-090a-7c3b-92f7-ac2c51f50db4"],
  "body": {
    "code": "not-accepted"
  }
}
```

The decline:

- uses the deterministic decline effect for this request;
- contains `ack` for the request and has no `please_ack`;
- creates no relationship DID and has no `from_prior`;
- uses one of the stable coarse codes `not-accepted`, `expired`,
  `sender-did-conflict` or `capacity`;
- is appended as `message.out` before any resolution, registration,
  encryption or submission effect; and
- is submission-terminal: ordinary retry continues only until the first
  successful submission, its own expiry or an explicit hold. A duplicate
  request may trigger re-submission of the same exact decline package.

A request that expires before an accept decision may be declined with code
`expired` while the deterministic decline itself remains unexpired; otherwise
the responder ignores it. A responder MAY always choose `ignore` and remain
silent to reduce oracle and amplification risk.

The initiator durably stores and acknowledges a valid decline. It treats the
request as declined only while no valid accept for the same `thid` exists.
A later valid accept wins and may establish the relationship; the decline
does not delete or tombstone anything.

If different replicas produced both accept and decline decisions for one
request, the responder fold exposes a decision conflict and suspends further
automatic response and ordinary relationship traffic. A subsequent durable
user decision outranks policy decisions and selects the intended outcome.
Already transmitted messages remain immutable observations; the initiator
still applies the valid-accept precedence rule above.

An authenticated problem report directly triggered by a request MUST include
`ack` naming the request wire ID. Whether it requests acknowledgment for
itself is defined by the error policy. A problem report without
`please_ack` is submission-terminal under `distributed-delivery/1.0`.
Unauthenticated input is dropped without portable state-changing effects.

## 14. Retries, rollover and expiry

- Retrying one request wire ID preserves its semantic content, public document
  hash, public authentication `kid` and public key-agreement `kid`.
- Package-specific addressing and routing bytes follow
  `distributed-delivery/1.0`; a retry through another route of the same
  generation may use another package ID.
- A replacement request with a new wire ID but the same initiator sender key
  reuses the same relationship/contact and receives its own threaded response.
- A replacement request presenting a different canonical initiator DID under
  the same sender key is a sender-DID conflict, not a route variation.
- `accept` and `decline` responses preserve their deterministic wire IDs and
  request-acknowledgment headers. `accept` requests its own ACK; `decline` is
  submission-terminal. Exact package bytes are immutable per package ID.
- Expired requests remain retained history. They cannot receive a new accept
  decision, but an accept validly created earlier and delayed in transit may
  still be processed under section 12 while its own response expiry is live.
- A non-retryable `expired` delivery failure ends automatic retry of that
  request wire ID. A later valid ACK or accept may update the observed outcome
  to acknowledged/accepted, but never restarts transmission.

Before a public generation becomes discoverable, its configuration, selected
DID document blob and route events MUST be durably committed and uploaded to
every configured sync store that publication policy requires. An unsynced
replica may defer decryption but cannot cause another replica to lose the
message because pickup ACK is per replica.

On normal rollover, private authentication and key-agreement material,
request-bound document blobs and ability to decrypt already queued packages
MUST remain available through at least:

```text
maximum request lifetime
+ mediator message retention
+ configured delivery safety margin
```

A sender retrying an unexpired request uses its durable request-bound snapshot
and MUST NOT silently switch to the successor generation. The current web DID
document may stop selecting the old key-agreement method for new requests;
this does not invalidate already pinned requests or historical snapshot
verification. Emergency compromise response may intentionally break these
availability guarantees.

## 15. Replica and deployment behavior

A web service holding the vault seed may run as an ordinary full replica. It
has one `replica_id`, participates in sync and receives the same mediator
deliveries as other active replicas.

No special host identity appears in rendezvous events or messages. The public
DID belongs to the vault, not to the process serving `did.json`. Moving
publication or adding another replica does not rotate established pairwise
relationships.

A thin client without the seed is not a replica, does not register for pickup
and does not appear in this protocol.

## 16. Privacy, abuse and security

The rendezvous DID is intentionally public and correlatable. Its DNS provider,
web host and mediator may observe bootstrap metadata.

Relationship DIDs are disclosed only in encrypted messages. They MUST NOT
appear in reusable public invitations or public DID documents.

Registering the public DID and relationship DIDs under one mediation account
allows that mediator to correlate them. A vault MAY use separate mediation
arrangements when this metadata link is unacceptable.

A public rendezvous endpoint creates responder-side cost and a liveness
oracle. Therefore:

- `auto` acceptance MUST NOT be the default;
- every responder MUST enforce request-rate, pending-request, active-contact,
  recipient-registration and storage bounds;
- `silent` is a valid policy outcome;
- decline and problem detail MUST be coarse; and
- expensive DID creation, recipient registration and response preparation
  happen only after a durable accept decision.

The mediator never receives a relationship ID, contact ID, policy mode,
replica label or application plaintext.

A valid `from_prior` proves that the controller of the request-bound public
DID document authorized one long-form relationship DID in this contact. It
does not globally link all pairwise DIDs from the vault.

Ordinary `did:web` security depends on HTTPS, DNS and control of the published
document. Estoc preserves exact request-bound evidence but does not turn
`did:web` into an append-only DID method.

## 17. Required conformance cases

1. A public OOB invitation contains a rendezvous DID and no relationship DID.
2. A request uses the initiator `did:peer:4` long form on first disclosure.
   Its plaintext `from`, protected authcrypt `skid` and decoded `apu` all name
   that same long-form DID/key.
3. After the long/short mapping is stored, either form is accepted in later
   authcrypt sender identifiers only when plaintext `from` is the same DID
   identity.
4. `message.out` for a request is committed before initiator recipient
   registration, DID resolution, encryption or submission.
5. The initiator canonical short DID is made reachable before first request
   submission.
6. Preparing a request stores and attaches its bootstrap channel before or
   atomically with `message.prepared`.
7. An `accept`, `decline` or request-triggered problem report explicitly
   acknowledges the request wire ID. `accept` requests handoff confirmation;
   `decline` itself is submission-terminal.
8. Two requests with different wire IDs but the same `(public DID, peer key)`
   derive one relationship/contact/pairwise DID and two correctly threaded
   response effects.
9. A tombstoned deterministic contact is not resurrected; a fresh initiator
   key creates a different relationship ID.
10. Two replicas accepting one request derive equal relationship, contact,
    pairwise DID, decision and response IDs.
11. A request is not rejected merely because its `created_time` is old while
    its `expires_time` remains valid and lifetime is within the maximum.
12. A sender that discovers request expiry before preparation or retry records
    non-retryable failure and submits no package.
13. An unknown JWE `kid`, or a configured generation that may become live but
    is not live yet, remains unacknowledged at the mediator and is retried
    after replica sync/fold changes.
14. Wrong-protocol, malformed, silent-policy and hard-admission-limit public
    input may be safely pickup-ACKed and discarded before `message.in`, with
    only bounded local diagnostics.
15. A generation is configured and sync-published before public discovery,
    but is not live until document publication and route registration verify.
16. An admitted `ask` request is durably stored before it is shown to the
    user; an `accept` decision after request expiry is invalid.
17. `from_prior` is validated against the exact request-bound DID document,
    not an unrelated later revision.
18. Missing historical resolution evidence defers acceptance processing and
    does not classify the proof as invalid or process `accept.ack`.
19. The initiator validates long-form DID, addressing and `from_prior` before
    applying the request acknowledgment or appending `peer.transitioned`.
20. The responder appends accept `message.out` before registering its
    canonical pairwise recipient DID; registration is completed before
    accept submission.
21. The responder uses its `did:peer:4` long form in plaintext `from`,
    protected `skid` and decoded `apu` in the first accept; the initiator
    records and later uses the canonical short form.
22. Ordinary responder packages are deferred until one request-specific
    accept receives a qualifying pairwise-channel handoff confirmation.
23. An ACK carried only by a problem report, decline, public-DID message or
    another channel does not confirm handoff.
24. A valid, unexpired accept takes precedence over a decline for the same
    request regardless of arrival order. A valid accept delayed beyond the
    request expiry may still transition while the accept's own expiry is live
    and is recorded as late.
25. Concurrent responder policy decisions of accept and decline are surfaced;
    one user decision overrides policy decisions rather than an LWW rule.
26. Reuse of one initiator key under another canonical Peer DID is a
    sender-DID conflict and cannot rewrite the relationship's remote DID.
27. Overlapping generations do not write conflicting `originGeneration`;
    origin request, generation and remote DID derive from the canonical
    earliest effective accepted request.
28. The public rendezvous DID never appears in ordinary `writeTo`; non-request
    traffic to its key is discarded by the bounded pre-vault gate.
29. Duplicate delivery of a request or accept causes re-submission of the same
    deterministic response/ACK package, not another logical response.
30. A rendezvous and relationship DID may reuse one mediated route and still
    receive independent per-replica delivery.
31. Public policy defaults to `ask`; `auto` is bounded and explicit; `silent`
    emits no liveness response or permanent vault message.
32. Adding a server replica changes only delivery and sync state, not the
    public DID or established pairwise DIDs.
