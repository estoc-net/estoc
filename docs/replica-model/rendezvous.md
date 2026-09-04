# rendezvous/1.0

Status: **draft** — public discovery and privacy-preserving handoff from a
vault-scoped rendezvous DID to one relationship-scoped DID.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

## 1. What it is for

A stable public identifier is useful for discovery, but it is a poor
identifier for an ongoing private relationship. Estoc therefore separates:

- a **rendezvous DID**, normally a `did:web`, which is public, reusable and
  resolves to a bootstrap delivery route; and
- a **relationship DID**, normally a `did:peer`, which is created for one
  relationship and used after bootstrap.

The rendezvous DID discovers a vault. It does not identify a replica and it
is not the address used for ordinary relationship traffic.

This protocol defines the first encrypted exchange and the handoff:

```text
public rendezvous DID W_A
        │
        │ request from relationship DID P_B
        ▼
Alice's vault
        │
        │ accept from relationship DID P_A
        │ with from_prior: W_A -> P_A
        ▼
P_A <--------------------------> P_B
       all later relationship traffic
```

The public request and later pairwise traffic may use the same mediator and
may use the same mediation account. `replica-mediation/1.0` applies the same
fan-out machinery to both kinds of recipient DID without requiring an
explicit role field.

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Out-of-Band 2.0 (`https://didcomm.org/out-of-band/2.0`);
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- `distributed-delivery/1.0`;
- `replica-mediation/1.0` when a mediator is used;
- the vault event semantics in `vault-events.md`; and
- this protocol family: `https://estoc.dev/rendezvous/1.0`.

## 3. Terms

- **Rendezvous DID** — a vault-scoped, publicly discoverable DID with role
  `rendezvous`. Version 1.0 profiles `did:web` for this role.
- **Relationship DID** — a vault-scoped DID with role `relationship`,
  created for one relationship. Version 1.0 profiles `did:peer` for this
  role.
- **Initiator** — the party that resolves or otherwise learns the
  rendezvous DID and sends `request`.
- **Responder** — the vault controlling the rendezvous DID.
- **Rendezvous generation** — an immutable binding between one public DID
  key generation, one published document revision, its accepted ingress
  routes and the route used for newly created relationship DIDs.
- **Relationship ID** — the responder's deterministic local entity ID for
  one accepted request. It is never sent to the peer.
- **Replica** — one writable full incarnation of a vault. A replica ID is
  not a DID and never appears in this protocol's application messages.

## 4. Invariants

1. A sender addresses the rendezvous DID or a relationship DID, never a
   replica ID.
2. The first `request` is encrypted to the rendezvous DID before mediation.
3. A successful `accept` is sent from a newly created relationship DID.
4. `accept.from_prior` proves a transition from the rendezvous DID to that
   relationship DID.
5. The transition is scoped to the one relationship. It does not retire the
   public DID or globally replace it for other peers.
6. Several replicas processing the same request MUST derive the same
   relationship ID, local relationship DID, contact and logical acceptance.
7. After a valid acceptance, ordinary messages use the two relationship
   DIDs. The rendezvous DID remains available for unrelated new requests.
8. A mediator treats rendezvous and relationship DIDs identically as
   recipient DIDs and stores only encrypted inner envelopes.

## 5. Public DID profile

A version-1.0 rendezvous DID MUST:

- use the `did:web` method;
- expose exactly one currently selected `keyAgreement` generation for new
  rendezvous requests;
- have at least one `authentication` verification method capable of signing
  a DIDComm `from_prior` JWT;
- publish at least one `DIDCommMessaging` service; and
- be controlled by key names represented in the vault event set.

The recommended service uses the vault's existing mediator:

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

The rendezvous DID MUST be registered as a recipient under every selected
mediated route before the document revision or an OOB invitation exposing it
is considered successfully published. A `did:web` publisher MAY expose the
prepared document provisionally so a mediator can resolve the authentication
method used by recipient-control proof; public discovery is not announced,
and `did.documentPublished` is not appended, until registration and a final
HTTPS re-fetch both succeed.

A document may retain older authentication verification methods so an
initiator can validate delayed `from_prior` proofs. Those methods need not
remain in the active `keyAgreement` relationship. Changing the active public
key generation, accepted ingress-route set or relationship-route template
for new requests creates a new rendezvous generation; version 1.0 does not
mutate an existing generation.

A direct HTTPS endpoint MAY also be present. It is only another transport
route to the same vault-scoped DID. It MUST NOT encode or expose a replica
ID, and failure of a direct route MAY fall back to a mediated route.

## 6. Out-of-band discovery

A public web page or QR code MAY expose an Out-of-Band 2.0 invitation whose
`from` value is the rendezvous DID:

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

The invitation MUST NOT contain a final relationship DID. Every identifier
inside the public invitation is treated as public. Private profile data is
sent only after an encrypted channel exists.

The invitation ID is discovery metadata, not the relationship ID. A reusable
invitation may result in many independent relationships.

## 7. Initiator preparation

Before sending `request`, the initiator MUST durably:

1. create or select a contact containing the responder's rendezvous DID;
2. create one local relationship DID dedicated to the prospective
   relationship;
3. associate that local DID with the contact; and
4. append the offline `message.out` intent for the request.

The initiator's relationship DID may be constructed while offline if the
chosen local route is already known. Resolving the responder's `did:web`
and preparing the encrypted package may happen later on any replica.

The initiator MUST NOT use a general public DID as the `from` value merely
because the responder is public. The request should begin with the private
relationship identity that the initiator intends to keep using.

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
  "from": "did:peer:4zQm...bob-for-alice",
  "to": ["did:web:alice.example"],
  "created_time": 1788442800,
  "expires_time": 1789047600,
  "pthid": "019b4d10-8eb8-7cb7-8a25-d51376ee3701",
  "body": {
    "goal_code": "establish-relationship",
    "goal": "Write to Alice"
  }
}
```

Requirements:

- `from` is REQUIRED and identifies the initiator's relationship DID;
- `to` contains exactly the responder's rendezvous DID;
- the message is authcrypted to the one currently selected key-agreement
  method of the rendezvous DID and the ultimate-recipient JWE contains exactly
  one recipient entry for that method;
- the protected recipient `kid` MUST map to exactly one live rendezvous
  generation at the responder;
- every retry carrying this request wire ID MUST target the same public
  key-agreement generation; it MAY use another ingress route listed by that
  same rendezvous generation, while crossing to a different key generation
  requires a new request and wire ID;
- `created_time` and `expires_time` are REQUIRED, with `created_time`
  strictly earlier than `expires_time` and within the responder's accepted
  clock-skew policy;
- `goal_code` is REQUIRED and version 1.0 defines
  `establish-relationship`;
- `pthid` MUST equal the OOB invitation ID when the request follows an OOB
  invitation and is omitted when there is no parent invitation;
- `goal` is OPTIONAL human-readable context; and
- the request itself need not include `please_ack`, because `accept` or a
  problem report is its protocol response.

A request received after its `expires_time`, or through a rendezvous
configuration whose acceptance window has closed, MUST NOT create a
relationship.

## 9. Deterministic responder materialization

Let:

- `request_mid` be the deterministic inbound MID from `vault-events.md`;
- `request_wire_id` be the request's DIDComm `id`;
- `public_did` be the exact rendezvous DID in `to`;
- `peer_key` be the authenticated initiator key; and
- `generation_id` be the unique live rendezvous generation selected by the
  local key generation that decrypted the request; the actual receiving
  route must be a member of its `ingressRoutes`.

The examples in this section use:

```text
public_did = did:web:alice.example
peer_key = k3j9n0m4x6q2w7c8v5p1d8s0fa
request_wire_id = 019b4d12-090a-7c3b-92f7-ac2c51f50db4
```

The responder derives:

```text
relationship_id = UUIDv5(
  cfb3704a-cae5-56f9-a3e6-d73cf8246646,
  RFC8785([
    "v1",
    public_did,
    peer_key,
    request_wire_id
  ])
)
```

```text
our_relationship_did_id = UUIDv5(
  50386028-0062-554d-9f0a-a5a21d300b56,
  RFC8785(["v1", relationship_id, "ours"])
)
```

```text
contact_id = UUIDv5(
  da33b3a9-0360-5acf-a089-3ceb1fd2ee6b,
  RFC8785(["v1", relationship_id])
)
```


The acceptance effect is also relationship-scoped:

```text
accept_effect_id = base64url(
  SHA-256(
    UTF8("estoc/rendezvous/1.0/accept\0") ||
    UTF8(relationship_id)
  )
)
```

Its automatic message `mid` and wire ID use the namespaces and derivation
rules in `vault-events.md` with `accept_effect_id` as the stable effect ID.

For the example inputs, the exact test-vector outputs are:

```text
request_mid = d770e714-b7f7-5c20-9c8a-d86eeb10a254
relationship_id = a50ce9c1-bbc1-5dac-8a48-3323eee29063
our_relationship_did_id = c2e062e8-8952-5140-8493-6e774086c4db
contact_id = b2e533aa-5047-5392-9dc6-647663fda4af
accept_effect_id = 1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc
accept_mid = bc32620f-4eba-56bf-ad29-32bfddbe8376
accept_wire_id = 47214cc6-a94e-56b0-8048-08f998004241
```

The relationship DID's generation-0 key names are therefore:

```text
did/<our_relationship_did_id>/authentication/0
did/<our_relationship_did_id>/key-agreement/0
```

Its DID document and service are constructed from:

- those seed-derived keys; and
- the `relationshipRoute` fixed by `generation_id`.

The responder MUST append, atomically when supported:

- `contact.created` using `contact_id`;
- `contact.attached` for the authenticated request channel;
- a second `contact.attached` for the future relationship channel formed by
  the new local key-agreement key and the authenticated initiator key;
- `did.created` for `our_relationship_did_id`;
- `contact.useDid` for the new local relationship DID; and
- `relationship.established` linking all of the above to `request_mid` and
  `generation_id`.

The exact same event payloads under the same semantic IDs are harmless when
several replicas race. Any inconsistent value under one relationship ID is
an integrity conflict and suppresses automatic acceptance.

## 10. `accept`

Message type:

```text
https://estoc.dev/rendezvous/1.0/accept
```

Example plaintext before encryption:

```json
{
  "id": "47214cc6-a94e-56b0-8048-08f998004241",
  "type": "https://estoc.dev/rendezvous/1.0/accept",
  "from": "did:peer:4zQm...alice-for-bob",
  "from_prior": "eyJ...",
  "to": ["did:peer:4zQm...bob-for-alice"],
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "please_ack": [""],
  "body": {
    "accepted": true
  }
}
```

Requirements:

- `from` is the responder's new relationship DID;
- `to` contains exactly the initiator relationship DID from `request.from`;
- `thid` equals the request wire ID;
- `from_prior` is REQUIRED;
- its protected header has `typ == "JWT"`, `alg == "EdDSA"` and a `kid`
  naming the authentication key of the rendezvous generation that accepted
  the request;
- its claims have `iss` equal to the rendezvous DID, `sub` equal to `from`
  and `iat` equal to the accepted request's `created_time`;
- the JWT signature verifies under that public authentication key;
- the message is authcrypted to the initiator relationship DID; and
- `please_ack` requests confirmation that the initiator durably accepted
  the new relationship DID.

To make active-replica output byte-stable, version 1.0 encodes the protected
header and claims as RFC 8785 canonical JSON, uses unpadded base64url and
EdDSA, and does not add optional JWT claims. The request's durable
`created_time` is the protocol's deterministic rotation-context time; the
transition becomes effective only when the encrypted `accept` and its JWT
are authenticated. Given the same generation key and relationship, every
replica therefore produces the same compact `from_prior` value.

The acceptance is the relationship-scoped automatic effect defined in
section 9. Its logical MID and wire ID are derived from `accept_effect_id`
under `vault-events.md`. Several replicas may prepare different encrypted
packages, but all emit the same logical acceptance.

## 11. Scoped transition at the initiator

After authenticating `accept` and validating `from_prior`, the initiator
atomically, when supported:

1. attaches the acceptance's new authenticated pairwise channel to the
   contact that sent the request; and
2. records `peer.transitioned` with:

```text
scope = relationship
contact = the contact that sent the request
from = responder rendezvous DID
to = responder relationship DID
```

The channel attachment and transition are deterministic semantic effects of
the acceptance, so concurrent replicas do not create another logical
relationship.

This transition affects only that contact's relationship context. It means:

- later messages for this relationship use the new peer DID;
- the public DID remains active for other initiators;
- another contact may independently transition from the same public DID to
  a different pairwise DID; and
- the vault MUST NOT globally union all pairwise DIDs that have the same
  public predecessor.

The initiator sends the requested ACK or its next ordinary message to the
new relationship DID. Receipt of any authenticated message addressed to the
responder's relationship DID confirms the handoff.

The responder SHOULD continue attaching the same `from_prior` value to
retries of `accept` until it receives such confirmation. It MUST NOT attach
that public-to-pairwise proof to unrelated relationships.

## 12. Decline and problem handling

A responder that recognizes the request but declines it MAY send:

```text
https://estoc.dev/rendezvous/1.0/decline
```

Example:

```json
{
  "id": "019b4d17-bfb5-7d76-948f-a5a66f8f4d78",
  "type": "https://estoc.dev/rendezvous/1.0/decline",
  "from": "did:web:alice.example",
  "to": ["did:peer:4zQm...bob-for-alice"],
  "thid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "body": {
    "code": "not-accepted"
  }
}
```

A decline does not create or disclose a relationship DID and has no
`from_prior`. The stable `code` MUST NOT contain sensitive policy detail.
A responder MAY instead remain silent to reduce abuse feedback.

Malformed authenticated requests MAY receive Problem Report 2.0. Anonymous
or unauthenticated requests are outside version 1.0 and SHOULD be dropped
without state-changing automatic effects.

## 13. Retries, duplicates and expiry

- Retrying `request` preserves its wire ID, canonical plaintext and public
  recipient key-agreement generation.
- Re-encryption randomness or outer routing may create another package for
  that generation, including fallback through another listed ingress route.
  A request MUST NOT reuse its wire ID with a different public key generation.
- Duplicate requests converge on the same inbound MID and relationship IDs.
- Retrying `accept` preserves its logical MID, wire ID, canonical plaintext
  and `from_prior`; only package IDs may differ.
- A request that expires before acceptance remains ordinary retained message
  history but creates no relationship.
- Retiring a rendezvous generation prevents new acceptance after its
  `acceptUntil` boundary. The keys and document evidence remain in the
  vault for verification of already accepted relationships.

On rollover, the old private key, accepted ingress and mediator recipient
state SHOULD remain usable for at least:

```text
maximum request lifetime
+ mediator retention
+ allowed clock skew
```

The old authentication method SHOULD remain verifiable in the current web
DID document for the same interval so delayed `from_prior` proofs validate.
The old key-agreement method MAY be removed from the active `keyAgreement`
relationship as soon as new requests are meant to select the successor.
Emergency compromise response may shorten these intervals.

## 14. Replica and deployment behavior

A web service holding the vault seed may run as an ordinary full replica.
It has one `replica_id`, participates in event/blob sync and receives the
same mediator deliveries as any other active replica.

No special host identity appears in rendezvous events or messages. The
public DID belongs to the vault, not to the process that serves `did.json`.
Moving publication or adding another full replica does not rotate pairwise
relationships.

A remotely connected thin client that does not hold the seed is not a full
replica, does not register for mediator pickup and does not appear in this
protocol. A future client-access protocol may submit commands to a full
vault runtime without changing public or relationship DID semantics.

## 15. Privacy and security

The rendezvous DID is intentionally public and correlatable. Its resolver,
DNS provider, web host and mediator may observe resolution or bootstrap
traffic metadata.

Relationship DIDs are disclosed only inside encrypted messages. They SHOULD
be single-purpose and MUST NOT be inserted into reusable public invitations
or public DID documents.

The mediator observes the mediation account and recipient DID in Routing
`forward.body.next` and can therefore distinguish DID methods. Registering a
public DID and relationship DIDs under one mediation account lets that
mediator correlate them as one account even though peers see only their own
pairwise DID. A privacy-oriented vault MAY select a separate vault-scoped
mediation arrangement for a relationship while reusing the same mediator
implementation and per-replica fan-out protocol.

The mediator MUST NOT receive an explicit role, contact ID, relationship ID,
replica label or application plaintext.

A valid `from_prior` proves that the controller of the public DID authorized
one relationship DID in one peer context. It does not prove that every
pairwise DID produced by that vault should be globally linked, and it does
not make the public DID private.

Ordinary `did:web` security depends on HTTPS, DNS and control of the
published document. Estoc records exact selected and observed document
revisions but does not turn `did:web` into an append-only DID method.

## 16. Required conformance cases

1. A public OOB invitation contains the rendezvous DID and no relationship
   DID.
2. A request is authcrypted from an initiator relationship DID to the
   rendezvous DID.
3. The same request received by two replicas derives the same relationship
   ID, contact ID, local DID entity ID, request and relationship channel
   attachments, and logical acceptance.
4. The responder's acceptance uses a relationship DID and a valid,
   byte-stable `from_prior` from the public DID whose `iat` equals the
   request's `created_time`.
5. The initiator attaches the new pairwise channel and records the
   public-to-pairwise transition only inside the requesting contact.
6. Two contacts may transition from the same public DID to different
   relationship DIDs without merging those contacts.
7. A rendezvous DID and a relationship DID may select the same reusable
   mediated route and both receive per-replica fan-out.
8. A sender never addresses or learns a replica ID.
9. A late or retired-generation request creates no relationship.
10. Retrying a request or acceptance does not create another logical
    relationship or protocol response.
11. Existing relationship traffic continues when the web publisher or
    public rendezvous route is unavailable.
12. Adding a server full replica changes only replica delivery and sync
    state; it does not change public or relationship DIDs.
13. Reusing one request wire ID with a different public key generation is
    rejected or surfaced as a protocol conflict before relationship creation,
    while retry through another ingress route of the same generation converges.
14. The relationship DID may use a different mediation arrangement from the
    public DID without changing any peer-visible replica semantics.
