# The Estoc vault events, version 3

Status: **draft, phase 1** — clean-break event vocabulary and fold rules for
one single-seed vault executed by exactly one active writable full runtime.
The event author is named `replica_id` so later replication can be added
without changing the event envelope, but multi-writer execution,
`replica-mediation/1.0` and `vault-sync/1.0` are deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

Every example below is the `type`, `roots` and `data` portion of an event
whose complete envelope is defined by `event-store.md`. Object CIDs and
retention semantics are defined by `dasl-objects.md`. A known event
type has a closed payload schema in version 3. The store itself validates
only the envelope; the vault layer validates the payload before append
and after ingest.

This document defines portable vault state. Socket state, pickup cursors,
retry timers, caches and traces are local state and do not appear here.

## 1. Model

A vault is one identity with one seed. Phase 1 permits exactly one active
writable full vault runtime at a time. That runtime may run in a local
application or on a server and can derive every vault-controlled
communication and mediation key.

The local runtime has a `replica_id`, used as its event author. In phase 1 this
name does not imply a network replica protocol, concurrent writers or
per-replica mailbox fan-out. It is retained as a future-compatible provenance
namespace.

The event model distinguishes three kinds of durable statement:

- **intent** — a user or policy decision that must survive offline and process
  failure, such as `message.out` or `contact.petname`;
- **observation** — a fact learned from authenticated bytes or an external
  service, such as `message.in`, `mediation.granted` or
  `delivery.acknowledged`; and
- **materialization** — retryable work made durable, such as the exact
  ciphertext named by `message.prepared`.

All current views are folds over immutable events. No portable mutable record
is authoritative. A later replication profile may merge events from several
authors, but that behavior is not required by phase 1.

## 2. Principles

1. **Intent precedes effects.** A user-visible action is committed as an event
   and referenced objects before DNS, DID resolution, encryption or network
   submission begins.
2. **Observations carry their evidence boundary.** A peer observation carries
   the local and peer keys authenticated by the envelope. A mediator
   observation names the mediation arrangement that produced it.
3. **Portable folds have no current-runtime parameter.** Event `author` is
   provenance, not ownership of communication state.
4. **Mediation and communication keys are vault-scoped.** The active full
   runtime derives them from the vault seed and can reconcile recipient
   registration, receive and continue pending delivery.
5. **Stable IDs make retries safe.** A logical message, an encrypted package
   and a mediator delivery have different IDs and different lifetimes.
6. **Duplicate work is expected.** Recovery before recorded submission,
   transport retry and mailbox redelivery may repeat work. Folds and handlers
   must be idempotent. Future multi-runtime execution must preserve the same
   identifiers.
7. **Conflicts are visible projections.** Concurrent or contradictory
   decisions remain events. A fold uses set semantics, explicit references or
   canonical latest-wins exactly where this document says so.
8. **Events are permanent; content may be erased.** An erase releases object
   roots. It never deletes a skeleton event.
9. **`replica_id` is not a security boundary.** It does not revoke a copied
   seed or create a second identity.
10. **A mediator is not the vault.** Mailbox ciphertext has bounded retention.
    The readable event/object set is the phase-1 recovery source. Deferred
    vault sync may add an encrypted remote mirror later.

## 3. Identity, seed and key names

### 3.1 Vault identity

The vault identity is the anchor DID in `config.json`. Two vaults are the
same identity exactly when their anchor DIDs are equal.

On unlock, the runtime derives the `anchor` key from the seed and MUST verify
the DID before using the vault. The anchor remains independent of rendezvous
and relationship communication DIDs. Disclosing a rendezvous DID or running
the full runtime on a server does not replace the anchor.

### 3.2 Single seed

One seed derives every vault-controlled asymmetric key. The current key
profile uses HKDF-SHA-256 with the `@estoc/keystore` v3 domain separation.
The same seed and same key name always produce the same key material.

Reserved names are:

| name | purpose |
| --- | --- |
| `anchor` | immutable vault identity anchor |
| `mediation/<id>/me` | DIDComm identity for one mediation arrangement |
| `did/<id>/authentication` | signing/authentication key for one communication DID entity |
| `did/<id>/key-agreement` | DIDComm key-agreement key for one communication DID entity |

In `did/...` names, `<id>` is the DID entity ID. Version 3 defines exactly
one authentication key and one key-agreement key per communication DID
entity. Key names are never renamed or reused. They do not encode a contact,
replica, domain owner or process location.

Changing a communication DID's keys or embedded service creates another
`did:peer:4` entity. A relationship continues through
`relationship.localTransitioned` under section 12.4; rendezvous replacement
follows `rendezvous.md` section 14. There is no local
communication-key generation or key-generation selection. Store generations
retain their separate storage meaning.

TLS private keys, DNS credentials, ACME account keys and web deployment
credentials are not vault communication keys and MUST NOT be derived from
these names.

The `replica.*` event-type prefix is reserved for deferred `replica-mediation.md`;
the `sync.*` event-type and `sync/` key-name prefixes are reserved for deferred `vault-sync.md`.

### 3.3 Replica IDs and authors

Each writable full vault runtime has one canonical UUIDv7 `replica_id`. Every
event it appends has:

```text
event.author = local replica_id
```

Phase 1 has exactly one active writer. The runtime may execute in an end-user
application or on a server; its location does not change event semantics.
There is no creation event or separate host identity.

A portable restore mints a new replica ID unless it is an exact move and the
old writer is permanently stopped. If two writable copies share an author,
`event-store.md` treats their divergent event sets as an author fork when they
meet. Network synchronization between different authors is deferred.

A remote client that does not hold the seed is not a full runtime, has no event
author and cannot turn a staged command into portable vault state by itself.

### 3.4 Entity IDs and reproducible UUIDv5 namespaces

Unless a rule below says deterministic, locally created entity IDs are
canonical UUIDv7.

No Estoc UUIDv5 namespace is an unexplained random constant. Every namespace
is reproducibly derived from the RFC 4122/9562 URL namespace:

```text
UUID_URL = 6ba7b811-9dad-11d1-80b4-00c04fd430c8

estocNamespace(purpose) = UUIDv5(
  UUID_URL,
  UTF8("https://estoc.dev/uuid/v1/" + purpose)
)
```

The version-3 purposes and resulting namespace UUIDs are:

| purpose | namespace UUID |
| --- | --- |
| `inbound-message` | `4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6` |
| `message-execution` | `6511fc66-4d39-589e-b2c7-7185a807b6c6` |
| `automatic-contact` | `bc4ed155-49e2-58d4-93da-a4ec78ff2f58` |
| `automatic-mid` | `8847bd57-5907-5bcd-9a71-d1e97cee3199` |
| `rendezvous-relationship` | `0c579b86-4002-5a4a-a2b6-df3c13d27e48` |
| `rendezvous-local-did` | `58972857-beaf-5df0-af7b-f1d0ebfcbbb5` |
| `rendezvous-contact` | `dec849c7-4961-5f33-94e7-702684d5a95c` |

A deterministic entity rule then computes:

```text
UUIDv5(estocNamespace(purpose), UTF8(RFC8785(name_array)))
```

`name_array` is the exact JSON array specified by that rule. RFC 8785
canonical UTF-8 gives unambiguous nulls, strings and field boundaries. A
runtime MUST derive and verify the namespace UUID from the URI above rather
than trusting a copied table constant. The table is a test vector, not a
second source of truth.

## 4. Channels and peer evidence

### 4.1 Channel key

A channel is a value, not an entity or stored directory:

```ts
type ChannelKey = {
  myKey: string | null;
  peerKey: string | null;
};
```

- `myKey` is the vault key name that decrypted or authenticated the
  message, or `null` when no local key participated.
- `peerKey` is the complete authenticated or selected peer public key in the
  canonical encoding below, or `null` for an anonymous sender.

Both fields MUST be present in a `ChannelKey` value. JSON null is a value;
an omitted field is invalid. Events may instead reference the key evidence
as specified below; they do not duplicate the channel's peer key.

The canonical public-key value follows the
[did:key identifier syntax and public-key encoding rules](https://w3c-ccg.github.io/did-key-spec/#did-key-identifier-syntax),
using only its base58btc multibase form (leading `z`) and omitting the
`did:key:` prefix. It retains the complete type-tagged public key, without a
fragment, hash or truncation. Equivalent supported JWK and multibase key
representations MUST normalize to the same string; key type, length and
encoding MUST validate. NIST-curve keys use compressed points under
[SEC 1 section 2.3.3](https://www.secg.org/sec1-v2.pdf) (including P-521),
with public-key type codes from the
[multicodec table](https://github.com/multiformats/multicodec/blob/master/table.csv).
Every deterministic ID and channel/scope comparison uses this exact string.

For an inbound observation it is the key that authenticated the message; for
an outbound package or resolution it is the selected recipient key. Selection
alone is not evidence of authenticated inbound traffic or remote receipt.

The executable key fixture used by this specification is X25519, public-key
codec `0xec` (unsigned-varint bytes `ec01`), with these 32 raw public-key bytes:

```text
0900000000000000000000000000000000000000000000000000000000000000
peerKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
```

`message.in` and `message.prepared` store `myKey` and `peerResolution`, with
no `peerKey` payload field. Their derived channel is
`{myKey, peerKey: peer.resolved(peerResolution).peerKey}`. For an anonymous
inbound only, null `peerResolution` yields null `peerKey`; an unavailable or
invalid reference is deferred or conflicted, never treated as anonymous.
In this document and the delivery profile, a message or package's `peerKey`
always means this derived value. `peer.resolved`, contact attachments,
`peer.transitioned`, profile and ACK observations retain their explicit keys.

Channels are enumerated from these derived values and complete channel values
in other validated events. No separate channel-creation observation is required.
Each event retains its own evidence: `message.in.presentedDid` preserves the wire spelling,
and `peer.resolved.presentedDid` preserves the spelling used for resolution.
First disclosure is validated from that evidence, not a channel's arrival order.

A DID is not part of the channel key. DIDs may rotate keys or routing
services. `peer.resolved` connects channels to peer DIDs. `peer.transitioned`
changes a peer DID only inside one contact relationship.

### 4.2 Mediation channels

Traffic between the vault and a mediator uses a local key beginning with:

```text
mediation/
```

Those channels are excluded from contact attribution. They belong to the
mediation fold.

## 5. Mediation, communication DIDs and routes

Mediation arrangements, communication DIDs and their private keys belong to
the vault. Their meaning never depends on the event author or the process
executing the full runtime. DID-document publication is outside vault state.

A communication DID has one of two roles in version 3:

```text
rendezvous    bootstrap discovery; did:peer:4
relationship  pairwise ongoing communication; did:peer:4
```

The role is application meaning. Delivery routes are reusable vault-scoped
transport configurations bound by DIDs. The mediator is method- and
role-neutral. Resolving an external DID, including `did:web`, does not create
a locally controlled DID entity or a publication obligation.

### 5.1 Mediation events

#### `mediation.created`

```json
{
  "type": "mediation.created",
  "roots": [],
  "data": {
    "id": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "mediatorDid": "did:web:mediator.example",
    "me": {
      "key": "mediation/019b2a51-118f-7e46-b31b-c63cd090c92c/me",
      "did": "did:peer:4zQm..."
    }
  }
}
```

This intent creates the stable vault-controlled identity for one mediation
arrangement. `me.key` MUST use the arrangement ID and `me.did` MUST match the
seed-derived key.

Repeating the same arrangement ID with different values is an integrity
conflict. A new attempt against the same mediator uses a new ID.

#### `mediation.granted`

```json
{
  "type": "mediation.granted",
  "roots": [],
  "data": {
    "id": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "routingDid": "did:peer:2.Ez..."
  }
}
```

This is the durable observation that the mediator granted the arrangement
and returned `routingDid`.

More than one distinct routing DID for one arrangement ID is a conflict. The
runtime MUST NOT guess which grant is authoritative; it establishes a new
arrangement or obtains an explicit current answer from the mediator.

#### `mediation.selected`

```json
{
  "type": "mediation.selected",
  "roots": [],
  "data": {
    "id": "019b2a51-118f-7e46-b31b-c63cd090c92c"
  }
}
```

This is the user's or policy's preferred mediation for newly configured
mediated routes. The latest event by canonical order wins.

Selection does not stop old arrangements from receiving. Any mediation
still referenced by a live route remains required.

#### `mediation.retired`

```json
{
  "type": "mediation.retired",
  "roots": [],
  "data": {
    "id": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "because": "replaced"
  }
}
```

Retirement is terminal for the arrangement ID. A procedure SHOULD retire or
replace every live route that depends on it first. If a retired mediation is
still referenced by a live route, the fold reports a routing configuration
conflict rather than silently changing a DID.

### 5.2 DID identity and keys

#### `did.created`

A locally controlled communication DID is a Peer DID:

```json
{
  "type": "did.created",
  "roots": [],
  "data": {
    "id": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "did": "did:peer:4zQm...rendezvous-short",
    "longForm": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "role": "rendezvous",
    "boundRoute": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
  }
}
```

`role` is `rendezvous` or `relationship`. The entity ID determines exactly
one authentication key name, `did/<id>/authentication`, and one key-agreement
key name, `did/<id>/key-agreement`, under section 3.2. Both keys are immutable
for that entity; their names are derived, not stored as payload fields.

For every locally controlled communication DID:

- `did` is the canonical `did:peer:4` short form;
- `longForm` is the validated self-resolving long form;
- `boundRoute` is REQUIRED and equals the route encoded in the input document;
- seed-derived public keys and route MUST match that document; and
- changing keys or route creates another DID entity and an explicit scoped
  transition.

The entity has a spelling set, not a DID string as its identity: in this
version the set consists of `did` and its validated `longForm`. A future
alias-declaration profile may extend that set with externally managed
spellings without making DID-document publication vault state; this version
defines no alias-declaration event or implicit equivalence from an external
document's claims.

The long form is disclosed before the short form is relied upon by a peer.
The short form is canonical for vault references and mediator recipient
registration after the mapping is known.

A deterministic rendezvous handler may use a UUIDv5 entity ID; ordinary
creation uses UUIDv7. Same ID with different identity fields is an integrity
conflict.

### 5.3 Delivery routes

A route is a reusable, vault-scoped transport configuration. It does not
belong to a replica or a single communication DID. One rendezvous DID and many
pairwise DIDs may bind the same route, which is how they reuse a mediator
or direct ingress without sharing an application identity.

#### `route.configured`

```json
{
  "type": "route.configured",
  "roots": [],
  "data": {
    "id": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "kind": "mediated",
    "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "endpoint": null
  }
}
```

`kind` is `mediated` or `direct`.

- A mediated route has non-null `mediation` and null `endpoint`.
- A direct route has null `mediation` and an absolute HTTPS or WSS
  `endpoint`.

A direct endpoint routes to a full vault runtime or an ingress service. It
MUST NOT identify one replica as the DIDComm application recipient. Configuring
the route does not itself register a recipient.

Equal configurations under one route ID are semantic duplicates. Different
values under one ID are an integrity conflict. A transport endpoint or
mediation change creates a new route ID and successor DID entities, allowing
old and new DIDs and routes to overlap during cutover. Each affected
relationship uses its own section-12.4 local transition; mediation selection
does not migrate existing DIDs or change their immutable routes.

#### `route.retired`

```json
{
  "type": "route.retired",
  "roots": [],
  "data": {
    "id": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "because": "replaced"
  }
}
```

Retirement is terminal for the reusable route ID. Every DID that binds it
becomes visibly unroutable; restoring communication requires a successor DID
bound to a live route, not a route selection on the old entity. Retirement
does not erase retained messages.

### 5.4 Disclosure

#### `did.disclosed`

```json
{
  "type": "did.disclosed",
  "roots": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "as": "oob",
    "uses": "many",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb",
    "goal": "Write to Alice"
  }
}
```

`as` is `oob`, `profile` or `direct`; `uses` is `one` or `many`. `oobId`
is REQUIRED when `as == "oob"` and null otherwise. `goal` is nullable.
A phase-1 one-use OOB invitation MUST disclose a rendezvous DID; its
durable bootstrap receipt consumes it under section 14.9.

This is the permanent record that a DID was revealed for a purpose.

Before disclosure, a mediated `boundRoute` MUST have a currently verified
recipient registration. A reusable invitation SHOULD expose a rendezvous DID
and MUST NOT expose a relationship DID. First disclosure exposes the validated
`did:peer:4` long form.

### 5.5 `did.retired`

```json
{
  "type": "did.retired",
  "roots": [],
  "data": {
    "id": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "because": "contact-deleted"
  }
}
```

Retirement is terminal for the DID entity. Its mediated `boundRoute` pair is
removed from the desired recipient set, and it is not chosen for new outbound
messages.

For a rendezvous DID, retirement stops new input when `did.retired` commits.
The writer rechecks DID liveness under the same lock as inbound commit; an
application candidate already committed remains eligible for relationship
materialization and a response from its pairwise DID, subject to current contact tombstones,
integrity and the pairwise DID's own lifecycle. Later deliveries to the retired
rendezvous key, including duplicates, are terminal wrong-recipient input under
`rendezvous.md` section 9. No timestamp cutoff or replay-time clock comparison
is required.

Retain keys and Peer document evidence needed to finish committed candidates,
unsubmitted outbounds and historical proof verification. Retirement of the
rendezvous DID or its ingress route does not by itself cancel those candidates;
their handoff can use the retained rendezvous signing key and a live pairwise
route. Emergency compromise policy may stop work sooner without rewriting
historical input, invitation consumption or proof evidence.

An envelope arriving for a retired relationship key MUST still follow ordinary
decryption, authentication and durable receipt when the recipient remains
eligible under `rendezvous.md` section 9.2; a terminal bound-route dependency
is not eligible, regardless of DID role. DID retirement alone stops sending
from that DID and removes its desired registration, not receipt. Its usable
mediation remains in section 14.2's required receiving set. Scope derivation
retains every local-chain member under section 12.4. New deterministic reply
intents require a usable local sender under `distributed-delivery.md` section
8.1; otherwise that work remains discoverable from committed input without
committing an intent. Contact tombstones prohibit renewed interaction and
require section 16.6's late-message cleanup. Retirement is not retroactive
erasure: historical events, key derivation and contact-scoped transition
evidence remain.

## 6. `identity.label`

```json
{
  "type": "identity.label",
  "roots": [],
  "data": {
    "name": "Alice"
  }
}
```

The latest value by canonical order is the user-visible identity name.
It is ordinary LWW metadata and has no key or protocol effect.

## 7. Contacts

A contact is a set of decisions identified by one `cid`. It may hold an
unverified rendezvous DID before any authenticated channel exists and later
move to a pairwise DID within the same relationship context. Protocol identity
is the relationship; contact IDs name decisions, not identity equivalence
classes.

### 7.1 Contact IDs

See `rendezvous.md` section 10.1.

### 7.2 Contact event schemas

#### `contact.created`

```json
{
  "type": "contact.created",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "because": "user"
  }
}
```

`because` is `user` or `automatic`.

#### `contact.petname`

```json
{
  "type": "contact.petname",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "name": "alice"
  }
}
```

Latest by canonical order wins for that `cid`.

#### `contact.flag`

```json
{
  "type": "contact.flag",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "flag": "pinned",
    "value": true
  }
}
```

Latest per `(cid, flag)` wins.

#### `contact.useDid`

```json
{
  "type": "contact.useDid",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "did": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "because": "relationship"
  }
}
```

This outbound preference associates one of our communication DID entities
with the contact. `because` is `relationship`, `rendezvous`, `manual` or
another documented policy value.

A normal established contact SHOULD use a local relationship DID. This
preference MUST NOT select a local rendezvous DID as the sender. The
initial-message procedure also sends from a local relationship DID; the
sender restrictions are defined in section 9.2. This event
says nothing about an authenticated peer channel. It cannot create a local
transition, choose a superseded chain member, or move a response to another
relationship of the same contact. Section 12.4 determines each relationship's
current local end; preference only selects among otherwise eligible targets.

#### `contact.peerDidAdded`

```json
{
  "type": "contact.peerDidAdded",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "did": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "because": "oob"
  }
}
```

This records a peer DID selected as an outbound target before or independently
of an authenticated channel. `because` is `oob`, `user`, `rendezvous`,
`resolved` or another documented source.

The event is a routing/contact decision, not proof that the peer controls the
DID. `peer.resolved` or a valid `peer.transitioned` supplies cryptographic
evidence later.

#### `contact.peerDidRemoved`

```json
{
  "type": "contact.peerDidRemoved",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "add": "019b2a64-86fa-7f28-a63a-5d70ce1d829a"
  }
}
```

`add` is the `eid` of one `contact.peerDidAdded`. Explicit references make
removal independent of wall-clock ordering. A scoped transition may make an
older rendezvous DID non-preferred without deleting the historical add event.

#### `contact.attached`

```json
{
  "type": "contact.attached",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement",
    "peerKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "because": "rendezvous",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb"
  }
}
```

`because` is `invitation`, `rendezvous`, `accepted`, `automatic` or
`manual`. `oobId` is nullable provenance naming the invitation followed by
this attachment. It is not invitation-consumption evidence.

This is the explicit decision that an authenticated channel belongs to a
contact. It is not inferred from a DID claim alone.

#### `contact.detached`

```json
{
  "type": "contact.detached",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement",
    "peerKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis"
  }
}
```

The latest attach/detach decision for the exact `(cid, channel)` by canonical
order decides whether the edge is live.

#### `contact.merged`

```json
{
  "type": "contact.merged",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "from": "019b2a66-c794-7b41-bff1-68a4ecdd0b67"
  }
}
```

This is a display-only grouping hint between two contact IDs. A UI MAY group
those contact views, but every member retains its own decisions and
relationship identity. This event MUST NOT affect attribution, DID selection,
transitions, message or execution identity, ACK scope, bootstrap receipt, invitation
consumption, deletion or erasure. It creates no protocol representative ID.

#### `contact.deleted`

```json
{
  "type": "contact.deleted",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da"
  }
}
```

This is a permanent tombstone for exactly the named contact ID.

## 8. Stored message document

Message application content is stored as one whole-resource raw DASL object
containing UTF-8 RFC 8785 canonical JSON. Version 3 uses the following closed
stored representation:

```json
{
  "body": {
    "text": "hello"
  },
  "attachments": [
    {
      "id": "a1",
      "description": null,
      "filename": "photo.png",
      "media_type": "image/png",
      "format": null,
      "lastmod_time": null,
      "byte_count": 48213,
      "data": {
        "kind": "base64",
        "root": "bafkrei...",
        "hash": null,
        "jws": null
      }
    }
  ]
}
```

`body` is the DIDComm application body object. `attachments` preserves wire
order. Every stored descriptor has exactly these members:

```text
id, description, filename, media_type, format,
lastmod_time, byte_count, data
```

Missing optional wire members and explicit JSON null both normalize to null.
A present empty string remains an empty string, except that a non-null
attachment `id` MUST be non-empty and consist only of URI unreserved
characters. This is the DIDComm 2.1 attachment-ID restriction required so the
ID can be safely composed into URI references; it is unrelated to object CIDs
or filenames. For example, `urn:uuid:...` is not valid here because `:` is not
an unreserved character. `lastmod_time` is an Epoch-Seconds integer or null.
`byte_count` is
a non-negative integer or null.

The `data` member has exactly one of these closed structural forms:

```ts
type StoredAttachmentData =
  | {
      kind: "base64";
      root: Cid;
      hash: string | null;
      jws: JsonValue | null;
    }
  | {
      kind: "json";
      root: Cid;
      hash: string | null;
      jws: JsonValue | null;
    }
  | {
      kind: "links";
      links: string[];
      hash: string;
      jws: JsonValue | null;
    };
```

For `base64`, `root` names the raw DASL object containing decoded bytes. For
`json`, it names the raw DASL object containing `UTF8(RFC8785(json value))`.
For `links`, `links` is a non-empty ordered array and `hash` is required.
Exactly one wire content carrier among `data.base64`, `data.json` and
`data.links` is accepted. Multiple carriers are ambiguous and rejected.

Normalization is deterministic:

- inline base64 is decoded once; `byte_count` becomes the exact decoded byte
  length, and a present conflicting wire value is invalid;
- inline JSON is RFC-8785-canonicalized; `byte_count` becomes the exact UTF-8
  length, and a present conflicting wire value is invalid;
- a links descriptor preserves the ordered link strings without fetching
  them; `hash` is required, and `byte_count` is the non-negative wire value or
  null;
- `hash` is the exact wire multihash string or null for inline data;
- `jws` is the exact wire JSON value, normalized as an RFC 8785 JSON value, or
  null;
- inline payload roots appear in the enclosing event's `roots`; link-only
  descriptors have no payload root; and
- unsupported descriptor or data members are excluded from this version's
  portable stored representation. A versioned protocol extension that needs
  another member MUST define its normalization and semantic projection before
  using it.

An implementation MAY retain additional raw-wire diagnostics outside the
portable stored message, but such diagnostics do not affect semantic equality.
There is no implementation choice about which portable attachment fields are
hashed.

Canonical projections and message hashes are defined by `distributed-delivery.md` section 5.

## 9. Outbound message events

### 9.1 IDs

- `mid` is both the outbound vault message entity ID and the innermost
  DIDComm plaintext `id`.
- `packageId` identifies one exact encrypted inner envelope and is Routing
  2.0 `forward.id`.
- mediator `deliveryId` is not stored by outbound events.

A user send mints one UUIDv7 `mid`. Every package uses it as plaintext `id`.
Outbound events do not store a second `wireId`. Inbound observations keep
their scoped MID and the received wire ID under `distributed-delivery.md`
section 9; the equality applies only to locally authored outbound messages.

An automatic effect derives:

```text
mid = UUIDv5(
  8847bd57-5907-5bcd-9a71-d1e97cee3199,
  RFC8785(["v1", effectKey])
)
```

The resulting `mid` is also the response's wire ID. Retrying or repackaging
preserves this one ID. Equivalent automatic effects therefore identify one
logical response.

### 9.2 `message.out`

```json
{
  "type": "message.out",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "target": {
      "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da"
    },
    "initial": null,
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "thid": null,
    "pthid": null,
    "createdTime": null,
    "expiresTime": null,
    "pleaseAck": [""],
    "ack": [],
    "headers": {},
    "body": "bafkrei...body",
    "attachments": ["bafkrei...attachment"],
    "intentHash": "<base64url-sha256>",
    "executionId": null,
    "handlerId": null,
    "effectKind": null,
    "ordinal": null,
    "effectKey": null
  }
}
```

`target` is exactly one of:

```json
{ "contact": "<contact ID>" }
```

or:

```json
{
  "channel": {
    "myKey": "did/.../key-agreement",
    "peerKey": "..."
  }
}
```

A contact target may select the peer's current pinned or verified DID in its
relationship, including a DID originally disclosed for rendezvous. The initial-message
procedure under `rendezvous.md` also uses a local relationship DID as sender.
An explicit channel target whose `myKey` belongs to a local rendezvous DID
is invalid; initial, ordinary and automatic sends use local relationship DIDs.
Ordinary relationship messages MUST NOT use a local rendezvous DID as sender;
the peer's choice of a public or pairwise DID does not prohibit replies.
A peer-key-null channel cannot be used for an authenticated reply.

For an automatic reply whose carrier derives relationship scope `R`, the
target MUST be `{contact: R.contact}` and preparation MUST use that same `R`'s current
local and peer ends. Another relationship of that contact cannot substitute
for an unavailable sender. Apply `distributed-delivery.md` section 8.1's
local-sender gate under the intent-commit writer lock. Ordinary contact sends
select among section 14.6's eligible relationships; the first valid package
fixes that outbound's relationship for every later repack.

`initial` is REQUIRED: null for ordinary traffic and deterministic responses,
or the following closed object for an initial attempt:

```json
{
  "ourDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
  "peerDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document"
}
```

An initial attempt targets a contact, uses a live local relationship DID
associated with that contact, and freezes the peer's exact disclosed DID
spelling. `rendezvous.md` section 8 owns classification, the guard against
ordinary sends before peer traffic, and initial-profile validation. This
metadata is excluded from the wire and intent hash but participates in full
event equality. It is never reconstructed from headers or changed after
commit. The `message.out` example above illustrates an ordinary intent.

Requirements:

- `createdTime` and `expiresTime` are Epoch-Seconds integers or null;
- when both are non-null, `expiresTime` is strictly greater than
  `createdTime`;
- null `createdTime` omits the DIDComm `created_time` header;
- `pleaseAck` is null or the exact ordered wire array; `ack` is the exact
  oldest-to-newest target array frozen by the response algorithm;
- `headers` contains every otherwise-unmodeled supported top-level DIDComm
  header and no reserved field, including `return_route`;
- `body` names the canonical stored message document;
- `attachments` is the distinct ordered list of object-backed attachment
  payload roots from that document; link-only descriptors add no entry;
- `roots` is the distinct ordered set of `body` followed by `attachments`;
- `intentHash` is computed under `distributed-delivery.md` section 5;
- `executionId`, `handlerId`, `effectKind`, `ordinal` and `effectKey` are all
  null for a user-authored send and all non-null for an automatic effect;
- a user-authored send has `ack == []`; honoring an inbound ACK request uses
  the deterministic response algorithm;
- `handlerId` and `effectKind` obey `distributed-delivery.md` section 11;
  `ordinal` stores its `decimalOrdinal` as a canonical non-negative decimal
  integer string (`"0"` for zero, otherwise digits without a leading zero);
- an automatic intent stores the complete producing tuple. Validation checks
  its execution ID against the carrier group, its tuple and intent against the
  producing protocol, recomputes its key under `distributed-delivery.md`
  section 11, and requires its `mid` to equal the section-9.1 derivation;
- the five automatic-effect fields are portable effect metadata excluded from
  the wire and intent hash; they still participate in full event equality;
- `thid`, `pthid`, `expiresTime` and all five automatic-effect
  fields are present with null when unused; and
- appending this event requires no network, resolver, mediator or socket.

A preparer emits `created_time`, `expires_time`, `thid` and `pthid` only when
non-null; emits `please_ack` whenever `pleaseAck` is non-null; emits `ack` and
`attachments` when non-empty; and expands `headers` at plaintext top level.

More than one `message.out` under one `mid` is allowed only when every field is
identical. Reuse of one wire ID with a different intent projection is an intent
conflict.

### 9.3 `message.prepared`

```json
{
  "type": "message.prepared",
  "roots": ["bafkrei...encrypted-envelope"],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "senderDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "recipientDid": "did:peer:4zQm...short",
    "peerResolution": "019b2a72-0626-7a87-a310-941fe4c1ce77",
    "fromPrior": null,
    "intentHash": "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA",
    "plaintextHash": "WkPpglZREjLGtviZ1L6c-R3EX1cTHtbe0sJrmhl77LQ",
    "envelope": "bafkrei...encrypted-envelope"
  }
}
```

This event makes one exact normalized encrypted envelope recoverable by every
replica.

Requirements:

- `senderDid` names a live local DID entity selected for the target under
  section 9.2's restrictions; for ordinary relationship traffic it is
  `currentLocalDid(R)` under section 12.4 at preparation;
- for an initial attempt, sender, recipient and pinned resolution also match
  `message.out.initial` under `rendezvous.md` section 8;
- `myKey` is that entity's key-agreement key and authorizes the plaintext
  `from` under the exact spelling used by the package;
- the plaintext `id` equals `message.out.mid`; its other semantic fields
  and immutable control headers equal the committed intent;
- `intentHash` equals the intent value;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- `peerResolution` names the exact `peer.resolved` evidence used to select
  the recipient key; its `peerKey` supplies the package's derived peer key.
  Its `myKey` equals the package's local key and its canonical `did` matches
  `recipientDid`. It is non-null for every phase-1 package, including a
  retained numalgo-4 resolution. First-package freshness and
  snapshot reuse follow `rendezvous.md` section 5.1;
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization. The `envelope` CID commits to those exact bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

All packages for one `mid` MUST preserve its intent hash. No new package may
be prepared after that MID is submitted under section 14.8. Before then, a
new package MAY change `senderDid`, `myKey`, `recipientDid`, the derived peer
key, `peerResolution` or `fromPrior` only when the change follows a valid selected
DID entity or verified contact-scoped continuation for the same logical target.
Every such change requires a new package ID and plaintext hash. A protocol may
be stricter; one initial-message wire ID pins the rendezvous DID snapshot and
recipient key.

Local rotation's current-sender, proof and repack rules are in section 12.4.
Liveness and current-end selection are producer checks at preparation and
submission, not retroactive invalidation of historical package evidence.
On a local-key repack, a new `peer.resolved` MAY re-express the pinned recipient
snapshot with the new `myKey`, retaining the identical document CID, DID
spellings, selected peer key, authorized methods and service. This is local
evidence rebinding, not a fresh resolution or a peer-chain extension.

The package names no recipient replica. Rendezvous and pairwise
relationship messages follow the same package rules.

### 9.4 `message.packageRetired`

```json
{
  "type": "message.packageRetired",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "because": "repacked",
    "replacement": "019b2a75-11bd-7ae2-8e41-279d84c2528a"
  }
}
```

`replacement` is nullable. Retirement permanently stops automatic
submission of this package; it does not terminate the logical message or
another package. Its envelope contribution is determined only by section
15.3's retention predicate. Retirement preserves the package's historical
submission and scope evidence; it cannot undo a completed submission.

### 9.5 `delivery.submitted`

```json
{
  "type": "delivery.submitted",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c"
  }
}
```

This says only that one transport endpoint accepted the attempt. It does not
mean route existence, mediator retention, pickup or ultimate durable receipt.

`packageId` MUST identify a valid `message.prepared` for this exact `mid`.
A local runtime appends this event after observing transport acceptance. Its
successful commit completes submission for the entire logical outbound under
section 14.8. If acceptance happened but this event did not commit, recovery
may resubmit the existing package. No pre-call attempt event is required.

Transport, endpoint and response status are local trace data. They are not
fields of this portable event and do not participate in the delivery fold.

### 9.6 `delivery.failed`

```json
{
  "type": "delivery.failed",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "scope": "message",
    "packageId": null,
    "code": "expired"
  }
}
```

This event records only a terminal failure. `scope` is `package` or `message`.
`packageId` is REQUIRED for package scope and null when no package exists.

- package scope makes that package terminal but permits
  another valid package for the same message.
- message scope stops all automatic preparation and
  submission for the intent.
- `code == "expired"` MUST be message-scoped.
- `code == "peer-key-changed"` is message-scoped with `packageId == null`;
  `rendezvous.md` section 5.1 defines this failure before package preparation.

Retryable failures, the `resolve`/`prepare`/`submit` phase and retry diagnostics
belong only to local trace and retry policy. They MUST NOT append
`delivery.failed`. Losing that local state does not terminate the intent or
change its portable delivery state.

A worker that observes `now >= expiresTime` for an unsubmitted outbound before
prepare or retry appends that expired failure and submits nothing. It does not
append an expired failure merely because an already-submitted message later
reaches expiry. A later user attempt requires a new `message.out` and wire ID.
Sensitive strings remain in local trace; `code` is a stable non-secret value.

### 9.7 `delivery.acknowledged`

```json
{
  "type": "delivery.acknowledged",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "<alice-pairwise-public-key>",
    "ackMid": "27c4471f-8937-501b-9ffb-a7eaeeebc178",
    "ackWireId": "21559fb4-1a9f-54b1-b8fa-1bf82700d365"
  }
}
```

This event is appended only after an authenticated ultimate peer plaintext
contains the outbound `mid` in its explicit DIDComm `ack` array and every
package-level address, transition and protocol-specific security precondition
for that ACK has validated. Threading or a natural response without `ack` is insufficient.
`ackMid` identifies the local inbound ACK-bearing observation.
One valid carrier observation MUST witness `ackMid`, `ackWireId`, `myKey`,
the derived `peerKey` and the explicit acknowledged value together. These keys
identify the ACK carrier, not necessarily the old outbound package's channel;
section 14.8's historical local/peer-chain membership permits rotation between
that package and its ACK.

An acknowledgment supplies receipt information independently of the outbound's
submission state. Duplicate observations are harmless. The earliest valid
carrier observation `at` under section 14.8, compared with `expiresTime`,
determines the `late` receipt indicator. ACKs neither create a missing `delivery.submitted` nor
change preparation, submission or envelope retention. Acknowledged means
durable receipt by the peer vault,
not read or business acceptance.

An ACK-bearing problem report may acknowledge delivery while still being
excluded from a higher-level protocol success condition. In particular,
rendezvous handoff confirmation has the stricter rule in the processing
profile defined by `rendezvous.md`.

## 10. Inbound message events

### 10.1 Deterministic inbound observation MID

See `distributed-delivery.md` section 9.

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "mid": "369d7a43-8dce-5b86-b073-e390d457f357",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "receiptOrdinal": "42",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "peerResolution": "019b2a71-4c18-760a-9017-b3e265aa89d0",
    "presentedDid": "did:peer:4zQm...short",
    "did": "did:peer:4zQm...short",
    "thid": null,
    "pthid": null,
    "createdTime": 1788442800,
    "expiresTime": null,
    "pleaseAck": [""],
    "ack": [],
    "headers": {},
    "fromPrior": null,
    "body": "bafkrei...body",
    "attachments": ["bafkrei...attachment"],
    "bytes": 48213,
    "signedBy": null,
    "receivedVia": {
      "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c",
      "deliveryId": "01J...opaque"
    }
  }
}
```

Requirements:

- `mid` is the deterministic observation value above;
- `receiptOrdinal` is a canonical positive decimal integer string assigned to
  this newly committed observation event under the vault-wide allocator below;
  it is immutable portable evidence, not an EventStore `ChangeToken`;
- `intentHash` and `plaintextHash` are computed under `distributed-delivery.md` section 5;
- `myKey` is the exact local key that decrypted or verified the message;
- `peerResolution` is REQUIRED and names the exact `peer.resolved` used to
  authenticate the sender. It is null exactly for an anonymous observation,
  in which `did`, `presentedDid` and the derived peer key are also null.
  An authenticated or signed sender requires DID resolution evidence; there
  is no DID-less authenticated-key fallback. A non-null reference supplies
  the authenticated peer key under section 4.1; its `myKey`, `did` and
  `presentedDid` match this observation. Sender authentication and evidence
  reuse MUST satisfy
  `rendezvous.md` section 5.1's freshness rule, including for duplicate
  deliveries. Commit/reuse that event and document first, then use its returned
  event ID in the separate inbound commit; later resolutions cannot replace
  the reference. Committed observations recover from retained evidence without
  new resolution. It is local
  evidence metadata, excluded from the message hashes;
- `presentedDid` is the exact DID spelling disclosed on the wire, including a
  Peer DID long form when first seen;
- `did` is the canonical peer DID, using Peer DID numalgo-4 short form after
  validating the long form, or null when no peer DID is available;
- `createdTime`, `expiresTime`, `pleaseAck`, `ack`, `headers` and `fromPrior`
  preserve normalized wire headers; absent `please_ack` is null, a present
  array is retained exactly, absent `ack` is `[]`, and no additional header is
  `{}`;
- ACK processing expands `""` in `pleaseAck` to this `wireId` and ignores only
  later duplicate targets; stored arrays are not rewritten;
- `headers` contains every otherwise-unmodeled permitted top-level member and
  MUST NOT contain any reserved field, including `return_route`;
- `thid`, `pthid` and `signedBy` are present with null when absent;
- event `author` identifies the active receiving runtime;
- mediation and delivery ID are null for direct transport without them;
- `bytes` is the canonical retained document byte length; and
- `attachments` is the distinct ordered list of object-backed attachment
  payload roots in the closed stored document; link-only descriptors add no
  entry; and
- `roots` is the distinct ordered set of body followed by those attachment
  roots.

Every newly committed `message.in` receives its own fresh `receiptOrdinal`,
including a recorded duplicate or transition-verified alias of an existing MID.
It MUST NOT copy an earlier observation's ordinal. Re-ingest of an existing
`eid` preserves its event and allocates no new ordinal.

The value matches `[1-9][0-9]*`. Comparison and arithmetic MUST use its exact
integer value, never lexical order or an inexact floating-point conversion.
On writable open, restore and full import, recover the high-water mark from
all accepted, payload-valid `message.in` events in this main vault, across all
authors and including erased messages:

```text
nextReceiptOrdinal = 1 + max(all historical receiptOrdinal values)
max(empty set) = 0
```

Allocation and inbound commit MUST be serialized across the active writer.
A batch assigns distinct ordinals in observation order. Aborted reservations
may leave gaps; contiguous numbering is not required. A cache may accelerate
allocation, but restart, deletion of `local/`, or a new `replica_id` or
`store_generation` MUST NOT reset the recovered high-water mark or reuse an
ordinal already present in accepted history.

Receipt identity is the pair `(author, receiptOrdinal)`. One author MUST NOT
allocate the same ordinal to distinct observation events. Distinct authors MAY
share an ordinal after restore or after merging independently run copies; this
is valid merged history, not an import incompatibility. The allocator above
still advances beyond every ordinal known in the current union.

For one observation `e` and one conflict-free logical message `M`, including
verified aliases, define:

```text
receiptOrderKey(e) = (integer(e.data.receiptOrdinal), e.author)
firstReceiptKey(M) = min(receiptOrderKey(e) for every valid observation of M)
```

Compare the tuples ascending, first by exact integer ordinal and then by the
canonical author string. The minimum is one complete observation key, not
independent minima of its components. ACK-target ordering uses this key only
within the carrier's validated logical peer scope. In a linear single-writer
history it preserves first-receipt order, including across restore and author
changes. For independently run histories it defines deterministic recovery
order, not a claim about physical receive time between disconnected writers.
This rule permits history union; it does not enable concurrent phase-1 writers
or establish multi-writer effect convergence.

A later observation does not renumber earlier events. Learning an older alias
or importing history may change this derived key for future decisions, but
MUST NOT change an ACK array already frozen in a committed `message.out`.

After `eid` deduplication, distinct events with the same `(author,
receiptOrdinal)` are a receipt-integrity conflict. Affected logical messages
are those observed by the conflicting events. Retain those events and
surface the conflict; do not use affected logical messages as newly
frozen ACK targets. Unaffected messages remain processable. Full import MUST
NOT reject an event union merely for receipt-ordinal reuse or this projected
conflict. The generic event store remains payload-opaque. Its section 5.3
`ForkedAuthor` check detects unseen events under the current local author; it
does not prove that every historical author is fork-free.

The active runtime appends this event only after retained objects are durable.
Only then may it ACK the account-scoped mediator delivery. Recipient and
sender-authentication triage for both rendezvous and ordinary relationship
traffic follows `rendezvous.md` sections 9.1–9.2. Recoverable key/route state or
unavailable required sender resolution produces no `message.in` and no pickup
ACK. Safely classified terminal input MUST instead be pickup-ACKed without
`message.in`; this exception cannot bypass durable receipt for input that
passes the receive and integrity checks.

### 10.3 Duplicate, transition and conflict rules

First group observations by deterministic `mid`.

Within one MID:

- equal intent hashes are one observation group;
- differing `receivedVia`, valid local recipient keys or valid complete
  plaintext hashes are package/replica observations;
- different intent hash is an intent conflict, whether application content
  or immutable control headers differ;
- different plaintext hashes are allowed only when each `from`, `to`,
  `from_prior` and resolution chain validates under the same logical target;
  and
- every conflict suppresses automatic application effects and disputed ACK
  handling until explicitly resolved.

Within one unique validated relationship scope, two authenticated MID groups
with the same `wireId` are one logical message only when:

1. their authenticated peer DIDs/keys are authorized by the same pinned
   document, or joined through verified relationship-scoped transitions,
   under `distributed-delivery.md` section 9;
2. the intent hashes agree;
3. every package-level address and transition proof validates; and
4. neither group is already conflicted.

This merge permits a sender to use another key in the same pinned document
or repack after a verified key/DID continuation without displaying or executing
one logical wire message twice. Reuse by an unrelated key, another relationship or
an unverified transition remains a separate message or conflict.

When intent hashes agree, `ack` and `pleaseAck` are stable across valid
observations because they are inside the intent projection. Valid
package-specific `from_prior` evidence may differ only alongside a permitted
address transition and remains independently verifiable.

A conforming pure ACK control message has:

```text
type = https://didcomm.org/empty/1.0/empty
body = {}
attachments = []
ack != []
pleaseAck = null
```

It is a control observation under section 14.7. Invalid empty-message variants
are not treated as pure ACKs.

Anonymous senders can intentionally reuse wire IDs, so applications SHOULD
apply stricter replay and automatic-handling policy to them.

### 10.4 Pickup versus ultimate acknowledgment


Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; each target in its validated `ack` array is resolved only as
`(carrier logical peer scope, wireId)`. A conflict-free local outbound in that
same relationship or exact non-transitioning channel scope may produce an
idempotent `delivery.acknowledged`. A wire ID reused by another peer or
relationship is never selected. Outbound membership is derived by section
14.8. A threaded or natural response without an explicit `ack` array does not
create that delivery observation.

## 11. Peer and profile observations

All events in this section carry a complete channel key. Peer DID evidence is
kept distinct from contact decisions and from our own DID entities.

### 11.1 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "roots": ["bafkrei...resolved-did-document"],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement",
    "peerKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "presentedDid": "did:web:alice.example",
    "did": "did:web:alice.example",
    "document": "bafkrei...resolved-did-document",
    "authenticationKids": [
      "did:web:alice.example#authentication-0"
    ],
    "keyAgreementKids": [
      "did:web:alice.example#key-agreement-0"
    ],
    "service": "did:web:mediator.example"
  }
}
```

This event is durable resolution evidence for one authenticated or selected
peer key.

- `presentedDid` is the exact DID string supplied by the peer or resolver.
- `did` is the canonical DID used by folds. For Peer DID numalgo 4 it is the
  short form; first disclosure keeps the long form in `presentedDid`.
- `document` names the raw DASL object containing exact RFC 8785 canonical
  resolved DID document JSON. Its CID commits to those bytes.
- the authenticated `peerKey` must be present under the named DID and exact
  document;
- `authenticationKids` and `keyAgreementKids` enumerate all methods authorized
  for those purposes in the exact retained document, with references resolved
  against its validated DID. They do not prove every listed key controlled the
  observed message; the key-agreement methods are historical chain evidence
  only when this snapshot is pinned by a relationship or verified transition
  under `distributed-delivery.md` section 9; and
- `service` is the selected DIDComm service URI or null.

For an initial message to a rendezvous DID, this event is the
initial-message-bound resolution snapshot. A later `from_prior` is verified
against this exact event and object, not an unrelated current web document.
If the event or object is temporarily missing, processing is deferred until
verified recovery material is available; absence is not proof that the
transition is invalid. Phase 1 does not depend on deferred vault sync.

For a `did:peer:4` first disclosure, the implementation decodes and validates
`presentedDid`, derives `did` and the document locally, and stores both forms.
A short form received before corresponding long-form resolution evidence is
known cannot establish an authenticated relationship.

Equivalent duplicate observations are harmless. Same presented/canonical DID
and document CID with incompatible contents is an integrity conflict.

### 11.2 `peer.transitioned`

```json
{
  "type": "peer.transitioned",
  "roots": [],
  "data": {
    "relationship": "9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "<alice-pairwise-public-key>",
    "from": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
    "presentedFrom": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document",
    "to": "did:peer:4zQm...alice-pairwise-short",
    "presentedTo": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
    "fromPrior": "eyJ...",
    "priorResolution": "019b4d11-22d3-7fd0-82fb-f33864a75dd4",
    "peerResolution": "019b4d14-18bd-77f1-b4a4-5c2a6c2694ba",
    "mid": "3e7a2368-4a71-5560-8785-348ca4fbf548"
  }
}
```

This event is lifted only from a valid DIDComm `from_prior` in the named
inbound message.

- `relationship` is REQUIRED and names the exact relationship whose peer end
  is continued.
- `contact` is REQUIRED.
- `from` is the canonical prior DID.
- `presentedFrom` is byte-for-byte equal to `from_prior.iss`.
- the protected JWT `kid` has a DID portion byte-for-byte equal to
  `presentedFrom` and is authorized by the named historical resolution;
- `to` is the new canonical DID; for Peer DID numalgo 4 it is the short form;
- `from` and `to` MUST differ; a same-DID document/key update, including
  long/short spellings of one DID, cannot use this rotation event;
- `presentedTo` is byte-for-byte equal to `from_prior.sub`, plaintext `from`
  and the DID portion of authcrypt `skid`; for Peer DID numalgo 4 it is the
  valid long form on first disclosure. Other supported peer DIDs use their
  validated exact spelling under `rendezvous.md` section 5.1;
- `priorResolution` names the exact `peer.resolved` event whose document and
  authentication method verify `fromPrior`;
- `peerResolution` names the successor's exact `peer.resolved`, equal to the
  selected carrier observation's `message.in.peerResolution`. That one
  observation must also witness `mid`, `peerKey`, `myKey`, `presentedTo` and
  the exact `fromPrior`; and
- `mid` is the actual inbound message entity carrying the proof.

The verifier MUST use the named historical resolution snapshot. A network
fetch of a newer `did:web` document is not a substitute unless the raw CID of
its canonical bytes exactly matches the pinned document CID. Missing snapshot
material creates a retryable deferred state; an invalid signature, claim, key
or long form is a conflict.

The relationship binding MUST name the same `contact`, and `myKey` MUST be a
key of `localChain(R)` under section 12.4, including a historical member.
The named inbound MUST authenticate the successor, and its derived peer key
MUST equal this event's `peerKey`. `from` MUST equal the canonical DID of `priorResolution`,
which is one of that relationship's pinned or verified predecessor snapshots
under `distributed-delivery.md` section 9, including the initiator binding's
pinned rendezvous predecessor.
A transition cannot move a peer end into a different relationship merely
because the contact or prior DID is shared.

For an initiator, first recover and commit the section-12.3 binding from the
initial package if needed. The first transition verifies against its pinned
snapshot; a later transition uses the named historical resolution for that
relationship's verified predecessor. `rendezvous.md` section 12 defines
snapshot selection and rotation validation. Commit transition evidence before
processing its carrier's ACKs or selecting response intents. Missing evidence
defers processing; ambiguous or incompatible attribution is a relationship
conflict. A valid new DID without continuation proof does not join this
relationship merely because it shares a thread or claims the same contact.

The processing procedure attaches the new authenticated channel to the named
contact, preferably in the same `Vault.commit`. The transition changes the
current peer end only in the named relationship within that contact. It does
not globally union the public DID with every pairwise DID and does not retire
`from` for unrelated peers.

The first committed transition pins its successor document. On a repeated
carrier/proof, reuse that transition; a later resolution or duplicate inbound
cannot enlarge its key set. The same relationship, predecessor and compact
proof with a different successor document CID is a transition conflict, not a
second authorization. Equivalent resolution events for the same exact document
do not change the key set. Import checks this evidence without selecting a
winner by arrival order.

A later valid transition may continue from `to` inside the same relationship.
Competing current ends are surfaced as a relationship conflict; canonical time
does not choose one. The compact JWT is evidence, not an object reference.

### 11.3 `profile.nameClaimed`

```json
{
  "type": "profile.nameClaimed",
  "roots": [],
  "data": {
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "wireId": "019b2a84-44dd-7d96-b98c-5195950a1b06",
    "name": "Alice L."
  }
}
```

This lifted observation preserves a claimed name after the source message
body is erased. It is not a verified identity name.

### 11.4 `profile.shared`

```json
{
  "type": "profile.shared",
  "roots": [],
  "data": {
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "wireId": "019b2a85-090f-75a4-beb3-8440780d46e9"
  }
}
```

This observes that our profile was sent on the channel. Duplicate lifted
observations are harmless.

## 12. Rendezvous and relationship observations

These events lift durable state defined by the profile in `rendezvous.md`.
Rendezvous DIDs and relationship DIDs are vault-scoped.
A server runtime has no special ownership.

### 12.1 Durable bootstrap input

An authenticated `message.in` is a bootstrap candidate exactly when `myKey`
maps through section 14.3's reverse key index to one immutable `did.created` with role
`rendezvous`. The key must be that DID's fixed key-agreement method. Its
canonical DID and peer key derived from `message.in.peerResolution` derive the
relationship under `rendezvous.md` section 10. Sender DID and exact document come from the
input's `peerResolution`. These committed references supply scope before
materialization; no separate receive-configuration reference is needed.

Candidate scope does not imply permission to materialize. Only an application
candidate as defined in `rendezvous.md` section 3 can become an origin or select
a handoff. Control observations under section 14.7 and other non-handoff input
retain their scope but do not themselves create a contact or relationship DID;
their ACK handling and recovery follow that same section-10 rule.

Before a new input commit, the writer applies `rendezvous.md` section 9.3's
integrity checks, including contact tombstones, sender-DID consistency and
one-use availability, and rechecks the recipient DID's live receive state
under sections 5.5 and 14.3. The input commit records durable receipt, with no
separate policy result. All valid application types and nullable timestamps
are received; there is no age or expiry comparison for accepting an initial.

Missing DID or exact resolution evidence defers; inconsistent recipient or
sender-DID evidence is an integrity conflict. Imports check the immutable
key/DID and resolution joins over the event union. The producer's serialized
live-state checks are not replayed using event timestamps, the importer's
present clock or current DID/route availability. Retirement does not invalidate
the historical candidate or its scope.

The scope-bearing input must commit before a dependent response intent.
Later tombstones and relationship-DID retirement can stop new work but cannot
select another scope or remove invitation consumption. Rendezvous retirement
allows committed candidates to finish under section 5.5.

### 12.2 `relationship.established`

```json
{
  "type": "relationship.established",
  "roots": [],
  "data": {
    "id": "9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3",
    "contact": "5015e216-bc69-52d8-a7e1-c5c3c9a01254",
    "originInboundMid": "8fa18330-6cb7-5ff2-b9b8-603c0a568194",
    "originResolution": "019b4d12-7e90-7622-bc67-3a624f0ec185",
    "originWireId": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "originCreatedTime": 1788442800,
    "peerKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "theirDid": "did:peer:4zQm...initiator-short",
    "ourDid": "adf87d8c-d357-5f96-bbae-f60fe5f18d58",
    "fromPrior": "eyJ...",
    "handoffMid": "058b727b-49c3-565f-a63e-7100fc9ce04c"
  }
}
```

This event freezes responder relationship state for the canonical rendezvous
DID identified by the selected origin input's `myKey` and the authenticated
`peerKey`.
Different initial message IDs or protocol types from the same authenticated
initiator key reuse the same relationship, contact, responder relationship
DID and route while remaining separate
application messages.

Before this event exists, the active phase-1 runtime selects the origin as the
first durable, conflict-free application candidate it is about to materialize
under `rendezvous.md` section 10. It records the
selected contact, local DID, origin, peer and handoff outbound,
together with the origin's exact sender `originResolution` and compact
`fromPrior`. Later candidates or duplicate observations cannot rewrite
those choices.

Other values come from immutable references:

| value | source |
| --- | --- |
| Rendezvous DID entity and canonical spelling | The selected origin `message.in.myKey` through section 14.3's reverse key index, then `did.created` |
| Responder long form and relationship route | `did.created(ourDid).longForm` and `.boundRoute` |
| Initiator's exact presented DID, long form for numalgo 4, and initial chain keys | `peer.resolved(originResolution)`, referenced by the selected origin `message.in.peerResolution` |
| Handoff wire ID | `handoffMid` |
| Handoff execution ID, effect key and `(handlerId, effectKind, ordinal)` tuple | `message.out(handoffMid).executionId`, `.effectKey`, `.handlerId`, `.effectKind` and `.ordinal` |
| Prior spelling, authentication method and rotation instant | verified `fromPrior` payload `iss`/`iat` and protected `kid` |

The referenced event skeletons survive content erasure. Erasure never selects
a new origin, proof or handoff intent.

Normative rules:

- `id`, `contact` and `ourDid` satisfy `rendezvous.md` section 10's derivations
  using the referenced canonical rendezvous DID and `peerKey`;
- `originWireId`, nullable `originCreatedTime`, `peerKey` and `theirDid` match
  the origin `message.in`, which must be an application candidate eligible for
  handoff selection under `rendezvous.md` section 10;
- `originResolution` equals that selected observation's `peerResolution`.
  It pins one exact sender document even if another observation of the same
  MID later authenticates under a different document revision. All origin
  field joins must be witnessed by one consistent observation, not assembled
  from incompatible observations;
- `fromPrior` verifies against the local rendezvous DID document identified
  by that origin input's `myKey` under `rendezvous.md` section 11.2 before its
  claims are used. `originResolution` is the peer's document and cannot
  authorize this locally produced proof;
- its `iat` is the integer Epoch-Seconds rotation instant sampled once by the
  materializing writer under `rendezvous.md` section 11.1, independent of
  nullable `originCreatedTime`. Validation checks the retained JWT; neither
  later observations nor restore resample that instant. Its `iss` is the exact
  prior spelling presented in the origin invitation or pinned snapshot, and its protected
  `kid` is authorized by that snapshot with a DID portion equal to `iss`;
- its `sub` equals `did.created(ourDid).longForm` byte-for-byte; every package
  carrying this proof uses that same value in plaintext `from` and the DID
  portion of `skid`/decoded `apu`;
- `did.created(ourDid).boundRoute` is selected and frozen when that pairwise
  DID is created under section 16.3. It may differ from the rendezvous ingress
  route; a later preference change cannot replace an already committed route;
- the referenced handoff intent's `executionId` equals the value derived for
  this relationship and `originWireId` from the carrier group containing
  `originInboundMid` under `distributed-delivery.md` section 9; its `effectKey`
  validates under that document's section 11; and
- `handoffMid` names one valid deterministic `message.out` for
  `originInboundMid` that freezes eligible ACK targets under
  `distributed-delivery.md` section 8.1 and requests its own ACK with
  `pleaseAck == [""]`. It ACKs `originWireId` only when that target was requested.

Missing reference evidence defers processing. Conflicting references or
inconsistent decoded proof claims are integrity conflicts, not another choice
of relationship material.

With the origin input and exact resolution already committed, the deterministic
contact, channel attachments, `contact.useDid`, responder `did.created`, this
event and handoff `message.out` SHOULD commit in one process-durable batch.
The response execution scope comes from the previous input commit, not this
proposed materialization batch. Equal statements are duplicates; different
values under one relationship ID are an integrity conflict. Recovery reuses
the committed input and frozen material without an expiry-based rejection.

A future multi-writer profile must coordinate origin selection before it can
claim convergence. Phase 1 has one active writer, so no remote race chooses a
different origin.

The responder repeats the exact stored `fromPrior` on every package from
`ourDid` until it receives an authenticated message in this relationship's
unique conflict-free scope addressed to `ourDid`. This is the first local
disclosure confirmation; later local transitions use section 12.4. `ourDid`
and this initial proof remain immutable historical material after rotation.
Handoff submission completes at committed `delivery.submitted`, independently
of peer receipt or handoff confirmation. A duplicate initial message cannot
cause another submission of that completed handoff MID.

### 12.3 `relationship.initiatorBound`

The initiator commits one portable relationship-scope binding from its initial
package and pinned resolution before first submission. The peer need not reply
or rotate its DID to establish this local communication scope.

```json
{
  "type": "relationship.initiatorBound",
  "roots": [],
  "data": {
    "relationship": "9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "ourDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "initialMid": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "resolution": "019b4d11-22d3-7fd0-82fb-f33864a75dd4"
  }
}
```

`initialMid` names the local outbound and is also its wire ID. This closed
schema has no peer handoff observation or rotation proof; peer continuation
belongs to `peer.transitioned` under section 11.2 and local continuation to
section 12.4.

Other values come from immutable references:

| value | source |
| --- | --- |
| Initiator long form and fixed key-agreement key | `did.created(ourDid)` under section 5.2 |
| Initial peer's presented and canonical spellings | `peer.resolved(resolution).presentedDid` and `.did` |
| Initial peer keys | every key-agreement key authorized by that exact pinned document under `distributed-delivery.md` section 9; the selected origin key is derived from the initial package's `peerResolution` |

`relationship` MUST equal the deterministic derivation over the canonical
rendezvous DID and the initiator's own key-agreement public key
(`did/<ourDid>/key-agreement`) in section 4.1's canonical encoding under
`rendezvous.md` section 10. For local creation, the retained initial
`message.out` under that document's section 8, local DID, contact, resolution
and valid `message.prepared` MUST already be committed.
The initial intent has non-null `initial` under `rendezvous.md` section 8 and
targets this exact contact. Its `initial.ourDid` equals `ourDid` and
`initial.peerDid` equals the pinned resolution's `presentedDid`.
Package `senderDid` equals `ourDid`, `peerResolution` equals `resolution`,
and `myKey` equals the local
DID's derived key-agreement key. The resolution's `myKey` equals that same key,
and its canonical peer DID matches the package recipient. The selected peer
method must authenticate the package's `peerKey`; incompatible package evidence
is a relationship conflict. Import validation checks these reference joins in
the event union; it does not infer batch boundaries from event ordering.

When no binding exists, select the first initial package the active runtime is
about to submit and freeze these references. Later initial attempts deriving
the same relationship reuse the binding without replacing its `initialMid`
or resolution. Their pinned peer DID/key pair must already belong to the same
verified peer chain; a changed resolver result alone cannot add a new key to it.
`rendezvous.md` section 5.1 defines message-scoped failure for a changed peer
key before preparation; it is not a conflict in this retained binding.
Incompatible contact, local DID or initial peer evidence cannot choose another
binding for that relationship. An imported incomplete prefix is reconciled from
the same retained initial-package evidence before inbound ACK or effect work;
missing evidence defers and ambiguity conflicts rather than choosing a winner.

These joins use retained event skeletons and the resolution object held by
`peer.resolved`; they do not require initial-message content. Receipt, erasure,
submission, later resolutions and peer rotations never replace this binding.
The pinned document's authorized key-agreement keys start the historical peer
chain under `distributed-delivery.md` section 9, so direct replies,
ordinary content and pure ACKs from that DID already have this relationship
scope. A valid rotation extends it; it does not create a second execution
identity for the same wire ID. Binding says nothing about remote admission,
receipt or application success.

In this Bob-local example, the public key used to derive `relationship` is
Bob's own `z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis`, not the remote
Alice key. Sections 9.7 and 11.2 use the schematic
`<alice-pairwise-public-key>` for a remote
successor key. These illustrative message IDs are not additional executable
MID vectors; `distributed-delivery.md` section 9 owns those vectors.

Recovery MUST enumerate prepared initial attempts identified by
`message.out.initial` under `rendezvous.md` section 8 with missing binding even
when no inbound response exists. Commit the binding first, then separately
commit any required transition evidence, then derive and commit response
intents from the committed scope. `rendezvous.md` section 12 handles incoming
traffic and rotation. A known peer DID or existing `delivery.submitted` does
not prove binding recovery is complete. No response intent may derive scope
from a binding or transition proposed in its own batch.

### 12.4 `relationship.localTransitioned`

This event continues our end of one existing relationship. It does not change
that relationship's ID, contact, initial binding, origin or peer chain.

```json
{
  "type": "relationship.localTransitioned",
  "roots": [],
  "data": {
    "relationship": "9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "fromDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "toDid": "019b6a10-12c0-7410-89ab-38e54b097c21",
    "fromPrior": "eyJ..."
  }
}
```

`relationship` and `contact` name the same validated binding. `fromDid` and
`toDid` are distinct local DID entity IDs with role `relationship`, not DID
strings. The successor uses a newly minted UUIDv7 ID and section 5.2's fixed
seed-derived keys and route. It MUST NOT already belong to another
relationship or occur earlier in this relationship's local chain. A local
relationship DID belongs to at most one relationship, independently of contact
display merges or outbound preferences.

For relationship `R`, **`localChain(R)`** is the rooted directed chain starting
at its immutable `ourDid` and extended only by validated
`relationship.localTransitioned` edges for that `R` and contact. It includes
every historical DID and its fixed key-agreement key, even after retirement.
**`currentLocalDid(R)`** is its unique final node, regardless of liveness;
retirement never selects an earlier node. Equal edge payloads are duplicates.
Different successors or proofs for one predecessor, cycles, joins from another
relationship, or incompatible DID/binding evidence are relationship conflicts.
Missing predecessors, DIDs or proof evidence defer the affected chain; neither
missing nor conflicting edges may be ignored to authorize work on an apparent
earlier end. Canonical event order does not choose a branch. Historical receipt
and submitted effects remain history, while affected new ACK/effect work stops.

Before appending an edge, the writer MUST have a committed, conflict-free
binding, `fromDid == currentLocalDid(R)`, a non-deleted contact and committed
confirmation that the peer knows `fromDid`. Confirmation is an authenticated
inbound in `R`'s unique conflict-free scope addressed to that exact local DID;
a no-handoff error does not qualify. The responder's initial confirmation
follows section 12.2, and each later edge is confirmed by receipt at its
`toDid`. A message at the predecessor does not confirm the successor. A new
edge cannot precede confirmation of the previous edge: the peer must know the
predecessor before receiving a proof signed by it. Import verifies these
evidence joins against the rooted predecessor prefix: confirmation must derive
`R` using that prefix and validated peer evidence, without this edge or its
descendants. Import may validate prefixes in dependency order; it does not use
event timestamps to infer producer ordering.

On the initiator, local rotation additionally requires a verified peer
continuation away from the binding's original rendezvous DID. Its current
peer end must be reached through section 11.2, so the proof is sent to that
established peer end under `rendezvous.md` section 12, not back to the original
rendezvous address. A direct reply from the original peer DID still permits
ordinary sends under `rendezvous.md` section 8, but does not meet this rotation
precondition. After local rotation, no further initial attempt may continue
this `R`: an initial from the successor key at a rendezvous DID would derive
a different relationship. The initial binding and `ourDid` are never rewritten.

`fromPrior` is the exact compact JWT created once for this edge under
[DIDComm DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation):

- `iss` equals `did.created(fromDid).longForm`, the exact first-disclosure
  spelling this profile requires the peer to pin; subsequent short-form
  traffic never replaces that predecessor snapshot;
- the protected `kid` has that exact DID portion and names the authentication
  method in the immutable predecessor document;
- `sub` equals `did.created(toDid).longForm`;
- `iat` is an integer Epoch-Seconds rotation instant sampled once under the
  writer lock, independently of message creation time; and
- the signature verifies with the predecessor's seed-derived authentication
  key and immutable document before any claims authorize the edge.

Commit the new DID, its contact preference and the edge atomically under
section 16.7, before disclosure, registration or send effects. No successor
document, route, proof byte or `iat` is reselected after commit, including after
restore or message erasure. The compact JWT and local DID documents are event
skeleton data, not collectible message bodies. A second rotation signs with
the previous successor, not the original rendezvous or root relationship DID.

Every new package in `R` uses its current local end. Until that end is
confirmed, it carries the edge's byte-exact proof, with plaintext `from` and
the DID portion of authcrypt `skid` equal to `sub`, and decoded `apu` equal
to that exact `skid` under `rendezvous.md` section 5.2. After confirmation,
new packages omit this proof and may use the
short form; already prepared exact packages are unchanged. The responder's
root, before any local edge, uses section 12.2's initial handoff proof instead.
An explicit ACK records message receipt separately; it confirms rotation only
if its carrier also satisfies the exact-successor receipt rule.

An operation rotating a previously live predecessor MUST keep that DID, its
route and mediation non-retired through successor confirmation. Both mediated
recipients stay in the desired registration set during that overlap. After
confirmation the predecessor MAY retire; a shared route or mediation MUST
remain while any other DID still needs it. Rotation alone retires none of
these resources. An already independently retired predecessor may still sign
a recovery transition if the confirmation and retained-key prerequisites
above hold; terminal resources are not revived. Explicit contact deletion,
manual retirement or emergency shutdown can end receipt sooner under sections
5.5 and 16.6, independently of a rotation's overlap procedure.

From edge commit onward, no package from a superseded local DID may be newly
submitted. For an unsubmitted ordinary contact-targeted outbound in `R`, retire
its superseded packages and repack from the current end under section 9.3,
preserving MID, intent, execution ID and frozen ACK targets. A queued automatic
reply uses its carrier's `R` even when it has no first package yet. A frozen
initial attempt or explicit-channel intent cannot change its pinned local key;
if that key is superseded, record message-scoped terminal
`delivery.failed(code="local-did-rotated", packageId=null)` instead of repacking
it. These eligibility rules apply immediately and recovery completes missing
package-retirement/failure observations. Submitted MIDs never reopen. If a
later independent retirement leaves no usable current end, existing intents
remain blocked by lifecycle rules until a valid successor exists; no alternate
intent or relationship is selected.

This event does not itself invent a DIDComm message or an ACK obligation. The
next eligible ordinary message carries the proof; an application may submit
an ordinary Trust Ping with a new MID to request a response. Loss after
committed submission never automatically reopens that MID. Section 16.7 owns
the local operation; `rendezvous.md` section 12 owns peer verification.

## 13. Automatic effects

`distributed-delivery.md` section 11 defines effect identity and commit ordering;
section 8.2 there owns the pure-ACK vector. Section 9.1 of this document defines
outbound ID derivation. `rendezvous.md` section 11.1 owns the
handoff response vectors; its section 13 defines remote error handling.

## 14. Folds

All folds accept events in any order and are deterministic over the set.
Canonical order is used only where stated.

### 14.1 Runtime-author fold

Phase 1 expects exactly one active local `replica_id`. For each author seen in
the event set, the fold reports `firstEventAt` and `lastEventAt`. An author
fork is an event-store integrity condition, not a normal multi-writer merge.

### 14.2 Mediation fold

For each mediation ID:

- exactly one consistent `mediation.created` defines mediator and key;
- one consistent `mediation.granted` makes it usable;
- any `mediation.retired` makes it terminal; and
- conflicting create or grant values make it unusable and visible as a
  conflict.

The preferred mediation is the latest `mediation.selected`. If it is missing,
ungranted, retired or conflicted, preferred is null and policy must select
another before configuring a new mediated route.

The **required receiving set** is every usable mediation that is either
preferred or referenced by a configured, non-retired, conflict-free mediated
route bound by a local DID with consistent identity/key evidence. This includes
a retired relationship DID that remains receive-eligible under `rendezvous.md`
section 9.2. DID retirement alone never removes its mediation from this set.
An unpreferred mediation leaves the set only when it has no such route/DID
dependency or becomes unusable; route/mediation conflicts remain visible.
This receiving set is independent of the desired recipient registration set:
draining retained deliveries does not re-register a retired DID.

The active runtime reconciles recipients and drains account-scoped pickup on
every reachable mediation in this set. A hosted runtime receives no special
ownership.

### 14.3 Route, DID and key fold

For each route ID:

- exactly one consistent `route.configured` defines the reusable transport;
- any `route.retired` makes it terminal; and
- conflicting configuration values make it unusable and visible as a
  conflict.

A bound route has a **terminal dependency** when that route or its mediation
is retired, either has a configuration conflict, or its mediation has
conflicting creation/grant evidence. Missing recoverable configuration or a
temporarily unavailable endpoint is not terminal.

For each DID entity ID:

- exactly one consistent `did.created` defines its spelling set, role, fixed
  keys and immutable `boundRoute`;
- disclosures are every valid `did.disclosed` in canonical order; and
- any `did.retired` makes the DID entity terminal.

The fold verifies all of the following:

- key names are derived from the DID entity ID and the fixed purpose suffixes
  in section 3.2;
- the seed-derived public keys match the Peer DID input document;
- the entity stores a valid long form and its derived canonical short form;
- its sole bound route matches that document and is configured, non-retired
  and conflict-free; and
- a mediated bound route references a usable mediation.

For recipient reconciliation, a live DID is a non-retired, conflict-free
entity satisfying those local identity and route checks. Current recipient
registration is not a prerequisite for entering the desired set; reconciliation
establishes it. A single route may be bound by many DIDs. This is transport
reuse, not DID or contact equivalence.

The desired mediator recipient set contains exactly each
`(canonical DID short form, boundRoute)` pair for a live DID whose bound route
is mediated. On every connection the phase-1 runtime queries each mediator
and reconciles that desired set with ordinary Coordinate Mediation
`recipient-query` and `recipient-update`. Current registration is runtime state,
not portable vault state. Registration diagnostics MAY be kept in local trace;
a restore re-queries the mediator before disclosure or submission. A future
mediator profile may additionally require a recipient-control proof.

Direct bound routes do not enter that set. They lead to a full vault runtime
or ingress service without naming a replica as the application recipient.

The fold also maintains a reverse map from every local communication key name
to exactly one DID entity. Both validated Peer spellings map to that entity,
but a recipient fragment must still identify its exact key-agreement method.
The map retains retired DIDs and DIDs whose routes retired for historical
input and proof joins. Present liveness controls sending and desired
registration; new receipt uses section 5.5 and `rendezvous.md` section 9.2's
eligibility rule, including its retired-relationship-DID exception.
Ambiguous or inconsistent mapping is an integrity conflict and prevents
cryptographic use.

### 14.4 Rendezvous and relationship fold

Rendezvous DIDs use the ordinary DID/route fold in section 14.3 and retirement
under section 5.5. Durable input is joined to its immutable recipient DID and
exact sender resolution under section 12.1, independently of present liveness.
Receive deferral follows `rendezvous.md` section 9.1, including unavailable
required sender resolution for an otherwise eligible exact recipient method.
Terminal or foreign input follows its section 9.2.

Every committed bootstrap candidate with consistent section-12.1 evidence
derives its deterministic relationship scope. It has no pending or rejected
policy state. Receipt and exact resolution evidence must commit before
response-scope derivation. Missing references defer and conflicting evidence
suppresses ACKs and new effects; no channel-scope fallback is permitted.

For each derived relationship, require one consistent canonical sender DID
across its bootstrap candidates and established origin. The same origin key
presented under a different canonical sender DID is a sender-DID conflict.
An independently verified later continuation is checked in its own
relationship under section 11.2; fresh resolution alone cannot rewrite origin.

Before a new candidate commit, integrity checks and one-use availability in
section 14.9 share the writer-lock operation. Before materialization, recheck
current contact tombstones and integrity conflicts. A later deletion blocks
new work but does not change historical execution identity or receipt.
Conflicting imported invitation consumers suppress effects for the affected
candidates and leave the invitation unavailable. Other imported conflicts
likewise preserve prior history and suppress affected new work; fold order
does not choose an input to execute.

Committed candidates recover without mediator redelivery, user review or an
expiry check. Only application candidates materialize under `rendezvous.md`
section 10; control and other non-handoff inputs retain that section's ACK-only
rules on recovery. Only protocol-supported automatic effects execute; unknown
application types remain stored and visible through ordinary message rules.
Relationship termination uses contact and DID lifecycle operations.

Group responder-side `relationship.established` and initiator-side
`relationship.initiatorBound` by deterministic relationship ID. Each side must
validate its own closed schema and derivation. Equal evidence is one
relationship; incompatible evidence for one ID is an integrity conflict. A
responder event freezes origin and its exact sender resolution, remote DID,
local DID, rotation proof and handoff MID; the rendezvous DID, pairwise route
and handoff effect data follow its immutable references.
An initiator binding records contact, local DID, initial outbound, pinned
resolution; DID spellings and keys follow the immutable references in section
12.3. Peer rotation is separate `peer.transitioned` evidence; local rotation
uses section 12.4. These values are not
re-selected from later arrivals.

A valid relationship contributes:

- one contact: deterministic for the responder, or the retained existing
  contact named by the initiator binding;
- bootstrap channel evidence, selected on the initiator and authenticated on
  the responder;
- peer DID/key authorizations from the pinned and verified chain snapshots,
  without inventing inbound observations for unused keys;
- one historical local DID chain and its unique current end under section
  12.4, each node retaining its immutable route;
- one current canonical remote DID, public or pairwise; and
- zero or more later deterministic protocol effects.

The pairwise handoff is confirmed when an authenticated message with that
unique conflict-free relationship scope is received at the responder
relationship DID. Until then, every package from that DID to the
contact carries the exact frozen `fromPrior` and uses the frozen long-form
sender spelling. An explicit ACK naming the handoff response records peer
receipt independently of submission completion; a message merely addressed
to the new DID confirms rotation but does not invent an ACK. Neither a
missing ACK nor incomplete confirmation reopens a submitted handoff MID.

A valid `peer.transitioned` changes current peer DID only inside its named
relationship and its matching contact. It never globally retires or aliases
the rendezvous DID.

### 14.5 Peer evidence and contact-scoped attribution

Build an evidence graph whose nodes are:

- channels with `peerKey != null`; and
- canonical peer DID strings.

The only global evidence edge is:

- `peer.resolved`: the exact channel to the canonical DID under which its
  authenticated peer key was found, together with the retained resolution
  snapshot.

A `peer.transitioned` edge is not global. It belongs only to its named
relationship and matching contact under section 11.2, and must name the exact
historical resolution evidence used to verify `from_prior`. Likewise,
`contact.peerDidAdded` is an outbound contact decision,
not global control evidence.

Exclude mediation channels from contact attribution.

For a channel, collect the distinct contact IDs from live `contact.attached`
edges reachable through its evidence graph:

- none: unattributed;
- one `cid`: attributed to it;
- several: multi-valued attribution conflict.

The fold never attributes an anonymous `peerKey == null` channel through the
graph.

For each relationship ID within a contact, apply only `peer.transitioned`
events naming that ID as a directed graph. A transition replaces its
predecessor only in that relationship. Several unretired current ends are a
visible relationship conflict.

### 14.6 Contact fold

Fold each `cid` independently:

- deleted when that ID has a `contact.deleted` tombstone;
- `petname` is latest by canonical order;
- each flag is latest by canonical order;
- `claimedName` is latest `profile.nameClaimed` across attributed channels;
- `attached[]` is every live attach edge;
- `ourDids[]` is every non-retired DID named by `contact.useDid`, including
  predecessors retained for receipt during local rotation;
- `peerDidSeeds[]` is every `contact.peerDidAdded` not named by a
  `contact.peerDidRemoved`;
- `theirDids[]` applies valid contact-scoped transitions to those seeds and
  peer DIDs evidenced by attached channels;
- `writeTo[]` is every non-conflicted relationship DID/channel meeting the
  portable sender, peer and route eligibility rules below; and
- `thread` is the logical application-message union below.

Ordinary `writeTo[]` excludes a local rendezvous DID as sender. A peer's
current pinned or verified DID remains eligible even if disclosed as a
rendezvous or public DID, subject to `rendezvous.md` section 8's qualifying
inbound requirement for an initiator relationship. Binding supplies its
initial peer end, but before that evidence it is available only through the
initial-attempt procedure. A direct qualifying reply permits ordinary sends
without a handoff. A verified transition replaces the current end only in
that relationship. Historical peer-chain membership alone does not make a
superseded address writable. Section 9.2 defines local sender selection and
the prohibition on local rendezvous senders.

For each relationship, only `currentLocalDid(R)` may supply an ordinary
sender. It must be non-retired and pass section 14.3's portable DID/route
checks; its relationship/contact must be conflict-free and not deleted, and
its peer end must meet the evidence and qualifying-input rules above.
`contact.useDid` cannot select an earlier local-chain member or a sender from
another relationship. These are portable eligibility checks: fresh network
resolution, online transport and observed recipient registration are subsequent
preparation/submission work, not prerequisites to entering `writeTo[]` or
committing intent. A later outage may block that work without changing scope.

A responder relationship may enter ordinary `writeTo[]` after durable
bootstrap receipt and pairwise relationship materialization. Until an authenticated message is
received at that pairwise DID, every prepared outbound package carries the
same byte-stable `from_prior`; implementations SHOULD prioritize the selected
handoff response to minimize reordering.

A fold MUST NOT select one of several current relationship ends by clock
order. Transition ambiguity, sender-DID disagreement and conflicting user
decisions are visible conflicts. A tombstoned deterministic rendezvous contact
is never recreated by another event with the same ID.

For a same-DID key change under `rendezvous.md` section 5.1, derive a
`peer-key-changed` diagnostic from the retained authenticated `message.in`,
its exact `peer.resolved` evidence and the unique relationship identified by
the local recipient DID and canonical peer DID. Show it in that relationship's
contact view, including when global DID-graph attribution is ambiguous; the
diagnostic is not a new attachment or execution-scope edge. Keep the affected
unscoped observation out of the application thread, unread count and normal
message notifications, and process no ACK or effect from its MID group under
`distributed-delivery.md` section 9. If relationship evidence is missing or
ambiguous, retain the ordinary missing-evidence or conflict diagnostic rather
than assigning this one to an arbitrary contact. This no-proof observation
remains unscoped after restart and body erasure. A later valid rotation to a
different DID authorizes traffic under that successor DID, not this old
same-DID observation; a fresh local initial can instead start a new
relationship. No new diagnostic event or retained body is needed.

The contact view derives attempt diagnostics from conflict-free logical
no-handoff errors classified under section 14.7 with a unique derived
relationship scope under `distributed-delivery.md` section 9. Match each
report against outbounds classified as initial attempts by `rendezvous.md`
section 8 in that relationship. The report's local recipient key must match
the initial package's sender key; its canonical sender DID must match that
package's recipient DID and its authenticated key must be authorized by that
package's exact pinned document under `distributed-delivery.md` section 9.
It need not use the one key originally selected for encryption.
Report Problem requires `report.pthid == (initial.thid ?? initial.mid)`
under `rendezvous.md` section 13; another protocol error uses its protocol's
correlation rule. Exactly one initial MID must match, with valid, conflict-free
evidence; dropping conflicted evidence cannot resolve an ambiguous match.
While the report body is available under section 15.2, the view MUST show its
diagnostic beside that initial outbound's delivery outcome in its target
contact. An ambiguous
or unmatched report produces no attempt diagnostic; its `ack` array is never
used to select the rejected attempt or to mark every acknowledged message
rejected.

Show Report Problem's validated body `code`, or the protocol-defined error
reason, once per logical report; multiple reports are ordered by their earliest
canonical observations, not reduced to a contact-wide rejection state. Erasure
removes that report's diagnostic even if another reference retains the bytes;
missing or damaged content follows section 15.2 and supplies no inferred reason.
Silent rejection supplies no remote diagnostic. These diagnostics neither
override an established relationship nor change section 14.8's delivery
precedence, retry or retention rules. Explicit ACK still means receipt; the
initial outbound follows the same submitted boundary with or without it.

### 14.7 Inbound message and execution fold

First group `message.in` by deterministic observation `mid`.

For each MID group:

- equal `intentHash` values form one observation group;
- collect every distinct valid plaintext hash, receiving channel,
  `receivedVia` and author observation;
- different intent hash is an intent conflict, whether application content
  or immutable control headers differ;
- every package-level address and security proof validates independently;
- erasure is applied before object presence; and
- conflict suppresses automatic effects and disputed ACK processing.

Derive scopes per observation and check row and MID-group consistency under
`distributed-delivery.md` section 9 before union.
An unresolved observation defers the whole group; derived relationship and
channel scopes in the same MID group conflict under that rule. Neither case
permits per-observation execution or ACK processing.

Union authenticated MID groups into one logical message only when they have
the same wire ID, resolve to the same unique validated relationship scope,
have sender DID/key pairs authorized by the same pinned snapshot or connected
by verified scoped transitions under `distributed-delivery.md` section 9,
and agree on intent hashes with valid package evidence.
This is the only cross-peer-key wire-ID merge.

Each resulting conflict-free logical group uses its derived execution ID under
`distributed-delivery.md` section 9 for ACK processing and automatic effects.

A **control observation** is one of:

- a conforming pure ACK under section 10.3;
- a valid response to an initial attempt of relationship `R`, of type
  `https://didcomm.org/empty/1.0/empty` or
  `https://didcomm.org/trust-ping/2.0/ping-response`, with valid protocol
  threading to that attempt. This includes direct replies from the pinned DID,
  handoffs validated under `rendezvous.md` section 12, and responses to a
  subsequent initial attempt on an already bound `R` under section 14.8,
  whether or not they carry `from_prior`; or
- a valid no-handoff error under `rendezvous.md` section 13: `fromPrior` and
  `pleaseAck` are null, its type is Report Problem or the initial protocol's
  deterministic error type, and it has valid protocol content and matching
  initial-package recipient/key evidence as defined in section 14.6. Section 14.6
  separately requires unique attempt correlation for a visible diagnostic.

Control observations remain durable. Their validated `ack`, transition,
binding and protocol-required confirmation effects follow the existing
processing rules, including the initial response's `ack` and any `please_ack`;
no-handoff errors generate no automatic response. They are excluded from
thread display, unread counts, notifications and application-content handlers.
A no-handoff report's attempt
diagnostic follows section 14.6. A received initial application message,
including Trust Ping `ping`, is not a control observation merely because it
bootstraps a relationship; the rendezvous fold projects the candidate. A type name alone
does not make an invalid Empty, handoff or error message a control observation.

Receipt at a rendezvous DID does not override these rules: a control candidate
never selects a handoff or becomes a relationship origin. The materialization
and ACK rules in `rendezvous.md` section 10 also exclude unmatched or invalid
Empty, `ping-response` and Report Problem input from handoff selection without
classifying it as valid control or hiding it by type alone. Valid receipt ACK
requests use the generic pure-ACK profile, subject to that section's existing
relationship and lifecycle prerequisites; no-handoff errors still receive no
response.

A user-visible thread contains each remaining logical application message once,
positioned by the earliest canonical observation unless its application
protocol defines another display time.

### 14.8 Outbound message and delivery fold

Group `message.out` by `mid`. Multiple identical intent events are one logical
outbound. Different fields under one `mid` are a conflict, including local
control fields excluded from the intent hash.

An automatic MID derives only from `effectKey`, so this same fold detects
different intents under one key. A conflicted MID retains all variants and
their package history, but MUST NOT prepare or submit any variant;
arrival order does not select a winner. Previously emitted effects remain
history.

Also group automatic outbounds with non-empty `ack` by `executionId`. Each
execution permits at most one such logical outbound MID, across all handler
IDs, effect kinds and ordinals. Exact duplicate intents count once. This
selection remains consumed after erasure, expiry or submission because the
intent skeleton remains history. Other protocol-defined effects with empty
`ack` do not consume the selection.

A local writer MUST reuse the selected ACK-bearing intent and reject an
attempt to add another MID to that execution's selection, including within one
batch. If import supplies distinct ACK-bearing MIDs for the same execution,
retain all as an automatic-response conflict and suppress preparation and
submission of every competing response; arrival order selects no winner.
Previously emitted responses remain history.

ACK lookup uses `(carrier.logicalPeerScope, wireId)`. Before applying an ACK,
derive the candidate outbound's membership from non-conflicted portable
evidence as follows.

For relationship `R`, an outbound belongs to `R` when either:

1. a valid `relationship.initiatorBound.initialMid` or responder
   `relationship.established.handoffMid` equals the outbound `mid`, which is
   also the acknowledged wire ID; or
2. its validated package sends from any DID in `localChain(R)` under section
   12.4 to a DID/key
   in `R`'s verified peer chain, including only independently verified scoped
   continuations; its target is either the exact contact named by `R` or an
   explicit channel that exactly matches that package's channel. The local DID
   and authenticated peer-chain evidence identify that same unique `R`.

Responder `originInboundMid` and `originWireId` name received input, not a local
outbound. Wire-ID equality alone never establishes the first path. A subsequent
initial attempt, identified under `rendezvous.md` section 8, may also belong
to an already bound `R` when its pinned rendezvous snapshot and local initiator
key independently derive that same
relationship ID; the original binding is not rewritten to name the new attempt.

All valid packages of one outbound MUST be compatible with the same
relationship attribution. Retirement preserves historical scope evidence;
repacking through a verified continuation preserves scope and MUST NOT move
one logical outbound into a different relationship. Incompatible relationship
or package evidence is a scope conflict, not a latest-package selection.

For a permitted non-relationship channel `C`, membership requires the exact
`(myKey, peerKey)` tuple in the explicit target or validated package. If both
supply channel evidence, they MUST agree. Matching one key is insufficient.
An initiator-side carrier missing required relationship binding MUST NOT fall
back to a provisional channel scope, including a no-handoff rejection report.
Execution identities are local and need not be the same at both ends. An ACK
proves receipt, never remote admission or a successful transition.

Exactly one compatible scope attribution for the requested processing path
must remain before applying the ACK. Missing evidence defers processing;
ambiguous or conflicting evidence suppresses it. Recovery may retry using the
original carrier after evidence arrives, with all original proof gates.

For a valid outbound:

- `packages[]` is every consistent `message.prepared` by `packageId`;
- all packages use the outbound `mid` as plaintext `id` and agree on `intentHash`;
- packages may differ in plaintext hash, sender/recipient DID, keys and
  `fromPrior` only under validated repack rules;
- one package is inactive after `message.packageRetired` or a package-scoped
  terminal failure, while its skeleton remains historical evidence;
- `acknowledged` is true if a valid authenticated inbound `ack` names the wire
  ID on a validated peer-scoped continuation under the membership rules above,
  the carrier has a unique derived scope, and all proof gates pass;
- `submitted` is true if any valid package has a committed
  `delivery.submitted` naming this exact `mid` and `packageId`. Validation uses
  the retained intent/package skeletons; collecting or erasing an envelope,
  retiring a package or later changing a route cannot remove completion;
- once `submitted` is true, no new automatic preparation, repackaging or
  submission is permitted for any package of that MID, including on duplicate
  input, restore or missing ACK;
- a message-scoped terminal failure, including expiry, permanently ends
  new automatic preparation/submission for that intent;
- before submission, work additionally requires no message terminal failure,
  unexpired timing, and valid available target/proof/content evidence.
  Submitting a chosen package also requires that it is not retired or
  terminally failed and its exact valid envelope remains available;
- `pleaseAck` and `acknowledged` do not affect these work predicates. An ACK
  received while `delivery.submitted` is absent does not synthesize completion;
  eligible submission may still resume.

For receipt timing, consider all valid committed `message.in` observations
whose explicit `ack` acknowledges this outbound under the scope and proof rules
above. `receiptInstant` is the earliest parsed RFC 3339 `at` among those
observations, including duplicates and distinct ACK carriers. `late` is true
exactly when `acknowledged` is true, `expiresTime` is non-null, and
`receiptInstant >= UnixEpoch + expiresTime seconds`; equality is late. It is
false otherwise. The fold uses no current clock or `delivery.acknowledged.at`.
This rule applies both to submitted messages and to expired unsubmitted
messages, whether or not an expired failure exists. A later duplicate cannot
make an already evidenced on-time receipt late.

The displayed submission outcome has this precedence:

```text
conflict
submitted
expired-or-terminal-failure
prepared
queued
```

`acknowledged` and its optional late indicator are separate receipt information,
not alternative submission outcomes. A missing ACK never downgrades a submitted
message. A later failure likewise does not erase evidence of submission.

After restore or local trace loss, the fold uses only this portable evidence.
An outbound with only `message.out` is `queued`, even if a previous runtime
recorded retryable failures in its trace. Existing prepared, submitted or
terminal evidence keeps its stated precedence; receipt observations remain
independent.

Expiry is an irreversible no-more-work boundary for an unsubmitted intent;
later authenticated evidence may add receipt information without restarting it.

The phase-1 active runtime processes every valid queued or retryable unsubmitted
message. Authorship never limits outbox ownership after an exact move or restore.
When a durable expiry has passed, no further preparation or submission is
allowed. An already-submitted message does not receive a new expired failure.

### 14.9 Invitation fold

An OOB disclosure with `uses == "one"` is available for a new consumer only
when its DID is not retired and no valid committed bootstrap candidate has
consumed it.

A section-12.1 candidate consumes the locally disclosed invitation at its
`message.in` commit when its immutable `pthid` names this `oobId` and its local
rendezvous recipient DID matches the disclosure. The consumer is the
relationship derived from that recipient DID and authenticated initiator key.
A matching `pthid` on an ordinary inbound or a message following a remote
invitation is not consumption. Neither attachment nor materialization is
needed to complete consumption.

The writer checks availability and commits the new candidate in one locked
operation. A different consumer of an unavailable invitation is rejected before
inbound commit, without a response effect. The same consumer may send another
initial, including one using a different invitation for that relationship;
that new invitation is consumed by its own matching inbound commit even when
the relationship was already materialized. Duplicate input reuses the original
consumer and never creates a second take.

A crash after receipt but before materialization leaves consumption durable.
Detach, contact deletion, content erasure, retirement and clock rollback never
reopen it. Imported candidate evidence for incompatible consumers keeps it
unavailable and surfaces an integrity conflict; it does not elect a consumer
by event order. Once a matching structurally valid candidate is present,
later sender/intent conflicts do not make the invitation available again.
No consumption or unconsumption event is needed.

A `uses == "many"` rendezvous disclosure remains open while its DID can receive
new input. It does not disclose a relationship DID.

## 15. Erasure and collection

### 15.1 `message.erased`

```json
{
  "type": "message.erased",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "drop": ["bafkrei...body", "bafkrei...attachment"],
    "because": "user"
  }
}
```

`because` is `user`, `contact-deleted` or another stable policy code.
`drop` contains roots named by one or more events for the message.
They are names to release and therefore MUST NOT appear in the erase
event's `roots`.

Erasure is global and permanent for that message/root relation. Object
bytes may remain because another message or event retains the same exact CID.
The erased message still reads erased.

### 15.2 Reading content

For a message root:

1. if any `message.erased` for the message names the root, state is
   **erased** regardless of object presence;
2. otherwise, if every required object is present, content is available;
3. otherwise, if the local view explicitly permits partial object availability,
   state may be **not yet fetched**; and
4. otherwise state is **missing or damaged**.

Missing bytes MUST NOT be displayed as intentional deletion.

### 15.3 Held roots

Under the writer lock in `event-store.md` section 10, the vault runtime computes
the held roots passed to `ObjectStore.collect` in `dasl-objects.md` section 8.3.

A root is held when at least one accepted event retains it through
`event.roots`, except that a root named by `message.erased` is no longer held
by that message.

This section is the sole normative owner of prepared-envelope retention.
For a consistent outbound `M` and valid package `P`, define:

```text
retainEnvelopeForMessage(M, P) =
    !erased(M, P.envelope)
    and !submitted(M)
    and !retired(P)
    and !packageTerminalFailure(P)
    and !messageTerminalFailure(M)
```

Terminal failure means valid committed `delivery.failed` at the
specified scope; a committed expired failure is message-terminal. Sampling wall
time beyond expiry blocks unsubmitted work but MUST NOT release its envelope
until that durable termination is committed. `submitted(M)` is defined by
section 14.8 and remains true after envelope collection or package retirement.
It releases this message's envelope contribution for every package. An ACK
does not affect retention, including when an outcome-unknown transport attempt
has no `delivery.submitted`.

Unavailable routes, retryable resolution failures and other reversible
scheduling conditions do not release an unsubmitted, non-terminal package.
There is no separate response-replay retention contribution or closure event.
After submission, even a duplicate inbound request cannot require these bytes
again or authorize a replacement package. The message's body/attachments and
its event skeletons keep their separate retention rules; completing submission
does not erase conversation content or receipt/scope evidence.

`erased(M, root)` names the permanent message/root relation, not global deletion
of a CID. Another independent non-erased reference may retain the same bytes.
Conflicted evidence is not release authority: disputed package roots remain
held until unambiguous release evidence or explicit erasure exists.

Submission eligibility additionally checks current time, addressing,
proof, route and available bytes. Scheduling eligibility is not a retention
predicate.

Unknown event types retain every exact root in their `roots` because version 3
defines no erase rule for them. A CID embedded in object content is not a
retention edge unless it also appears in an accepted event's `roots`.

### 15.4 No runtime-local eviction event

Version 3 does not represent local body eviction as a portable event. A local
storage policy that deletes a non-erased retained object makes the phase-1
vault incomplete. It may be repaired from a verified folder import or backup.
Deferred `vault-sync/1.0` may later provide another repair source. Local
absence never authorizes collection elsewhere.

## 16. Procedures

Initial send and receipt are defined in `rendezvous.md` sections 8.5 and
10.2; ordinary send and receive are defined in `distributed-delivery.md`
sections 4.2 and 9.1. These wire procedures and the runtime procedures below
define required ordering. Implementations may combine steps transactionally
but may not reverse the durability boundaries. Every instruction to append
an event below means `Vault.commit(objects, drafts)`, using an empty object
list when no new objects are needed; `Vault.events` is read-only.

### 16.1 Open the writable full runtime

1. verify folder/store version and anchor;
2. unlock or obtain the seed;
3. acquire the exclusive writer lock before creating mutable local state;
4. complete backend recovery and any import publication barrier, then load or
   mint local `replica_id` and `store_generation`;
5. fold portable state and reconstruct committed held roots before permitting
   GC;
6. project receipt-integrity conflicts and recover the vault-wide ordinal
   high-water mark under section 10.2 before accepting a new inbound
   observation; cross-author ordinal reuse does not block open or import;
7. recover missing bindings for prepared initial attempts identified under
   `rendezvous.md` section 8 and validated under section 12.3, then enumerate
   committed inbound observations with unfinished application candidate
   materialization, transition, ACK or protocol-defined deterministic effect
   work; control input never becomes a materialization trigger on recovery;
8. idempotently reconcile those observations, relationship materialization,
   committed local transitions, ordinary erasure closure and eligible
   unsubmitted outbound work from portable history. Reuse section 12.4's
   successor/proof, finish affected package retirement or terminal failure,
   and rediscover reply work whose local sender was previously unavailable
   under `distributed-delivery.md` section 8.1;
9. derive every required mediation account; and
10. independently start recipient reconciliation, account-scoped pickup, live
    delivery and eligible outbox work.

Recovery in steps 7–8 MUST NOT depend on mediator redelivery or a surviving
local queue. It reuses frozen ACK arrays, output intents and execution IDs;
submitted outbounds never resume, including deterministic responses whose
carriers are observed again. An outbound without `delivery.submitted` may
resume eligible work even when an earlier transport call might have succeeded;
it does not invent missing evidence or choose new response work merely
because a cache was lost. Missing objects or proofs keep the affected work
deferred. Protocol-defined external effects retain their existing idempotency
or explicitly at-least-once contract; this procedure makes no exactly-once claim.

Phase 1 MUST NOT require `replica-mediation/1.0` or `vault-sync/1.0`. Failure of
one mediator MUST NOT prevent offline local vault use or communication through
other live DIDs and routes.

A server holding the seed follows exactly this procedure and is the one active
full runtime. A remote thin client without the seed does not.

### 16.2 Establish mediation

1. append `mediation.created` before the network request;
2. derive its vault-scoped account key;
3. perform ordinary Coordinate Mediation;
4. on grant, append `mediation.granted`;
5. reconcile desired recipient DIDs through Coordinate Mediation; and
6. append `mediation.selected` when policy chooses it for new mediated routes.

The phase-1 runtime uses ordinary account-scoped Message Pickup. It sends no
`replica_id` to the mediator. A network failure after step 1 leaves a retryable
intent, not a half identity.

### 16.3 Create a relationship DID

This procedure is used by an initiator before rendezvous, by a responder
materializing committed bootstrap input, and by protocols that create ordinary
pairwise relationships. A responder uses its deterministic entity ID under
`rendezvous.md` section 10. If `did.created` for that ID already committed,
recovery MUST reuse its keys, document and `boundRoute`; it cannot select
another route even if preferences changed or the old route became unavailable.
A conflicting or retired entity suppresses new work under the ordinary fold.

1. choose one configured live route, creating it first when necessary;
2. mint a UUIDv7 DID entity ID unless a protocol requires deterministic
   UUIDv5;
3. derive the entity's authentication and key-agreement keys;
4. construct Peer DID numalgo 4 from those keys and route;
5. derive and retain both its long form and canonical short form;
6. append `did.created` with `did == short form`, `longForm == long form`, role
   `relationship` and `boundRoute` equal to that route; and
7. associate the DID entity with the intended contact through
   `contact.useDid`.

For a mediated bound route, reconcile and verify registration of the canonical
short form before first disclosure. The first DIDComm message that reveals the
relationship DID MUST use the long form. Subsequent messages follow
`rendezvous.md` section 5.2's spelling rules. Mediator registration uses the
canonical short form, including before confirmation.

Changing keys or bound route creates a new relationship DID and a
`relationship.localTransitioned` under sections 12.4 and 16.7. The existing
DID entity is not edited. Route choice remains local policy; no portable
mediation-migration or route-selection event is implied.

The responder chooses its pairwise route at this creation step, independently
of the rendezvous ingress route. A crash before `did.created` commits leaves
no frozen route; a later attempt may choose any currently usable route. A
partial materialization that already committed that event must reuse it.

### 16.4 Create and disclose a rendezvous DID

The Peer profile requires no domain or network resolver:

1. create or choose one reusable route, usually mediated;
2. mint a UUIDv7 DID entity ID and derive its authentication and key-agreement
   keys;
3. build and validate a `did:peer:4` long form whose input document embeds
   those keys and exactly that bound route;
4. append `did.created` with both Peer spellings, role `rendezvous` and the
   bound route;
5. when the bound route is mediated, reconcile and verify registration of the
   canonical short form; and
6. append `did.disclosed`, exposing only the rendezvous Peer DID long form in
   an OOB invitation, QR, file or another discovery object.

The non-retired, conflict-free rendezvous DID is ready to receive after local
long-form validation and current bound-route reconciliation under section 14.3.
If the active runtime temporarily cannot map the recipient key, it leaves the
mediator delivery unacknowledged until local state is repaired and refolded.
The rendezvous DID belongs to the vault, not the process displaying the invitation.

### 16.5 Erase a message

1. fold every root currently retained by the logical message and its prepared
   packages;
2. process-durably commit the erase event(s), preferably in one `Vault.commit`;
   and
3. run the locked held-root fold and collection under section 15.3.

Late duplicate observations may introduce another event retaining the same
logical roots. The active runtime that observes an existing erase MUST append
an equivalent erase for newly learned roots of that message before those roots
are considered intentionally released. A future replicated profile applies the
same closure rule in every full copy.

### 16.6 Delete a contact

1. append `contact.deleted` for the exact `cid`;
2. for every message exactly attributed to that contact, append erases for
   body, attachment and prepared-envelope roots required by policy;
3. retire relationship DIDs exclusively associated with that contact;
4. unregister their mediated bound-route pairs, retiring a reusable route only
   when no other live DID requires it;
5. preserve a shared rendezvous DID unless separately retired; and
6. run the locked held-root fold and collection under section 15.3.

A late message durably received under section 5.5 and attributed to that
tombstoned contact requires the same idempotent cleanup procedure. It cannot
resurrect the contact or authorize a new response. A terminal recipient under
`rendezvous.md` section 9.2 instead produces no new `message.in` to clean up.

### 16.7 Rotate a local relationship DID

1. under the writer lock, identify one `R`, check section 12.4's binding,
   confirmation, contact and peer-end prerequisites, and use its current local
   end as `fromDid`; missing evidence defers and conflicts reject the operation;
2. select one configured live route, reusing the old one for a key-only change
   or another route chosen by local policy. The route must already be configured;
   any mediation it uses must be granted and usable under sections 5.1 and 16.2;
3. mint one UUIDv7 successor ID, derive its fixed keys and build its numalgo-4
   document with that route; sample `iat` once and sign section 12.4's proof;
4. use one `Vault.commit` for successor `did.created`, `contact.useDid` and
   `relationship.localTransitioned`. Keep the lock through revalidation and
   commit; do not retire the predecessor, route or mediation in this operation;
5. reconcile and verify the successor's mediated recipient registration before
   first disclosure; resume unfinished reply work under `distributed-delivery.md`
   section 8.1 and prepare ordinary messages and repacks under section 12.4;
6. derive confirmation from committed inbound at this exact successor, then
   permit retirement of obsolete predecessors/resources under that section.

A crash before step 4 commits leaves no chosen successor or proof; retry may
choose fresh uncommitted material. After commit, recovery resumes steps 5–6
from the edge and referenced DID, reusing its exact route, keys and JWT. It
does not rerun steps 2–4 to create another successor. Missing referenced
material defers that same operation. This procedure rotates one relationship;
a shared mediation and unrelated relationships retain their own state.

## 17. Merge, synchronization and restore

### 17.1 Event merge

Merge is event-store union by `eid`. It never:

- rewrites an event;
- removes another replica's decision;
- treats another author as read-only history; or
- adopts a segment as opaque state.

After merge, every fold is recomputed from the union.

### 17.2 Object merge

Compute held roots from the prospective event union and copy only valid absent
objects required by that fold. Full import publishes events and available
objects under `event-store.md` section 11.3's complete-view boundary; this
semantic union is not permission to expose an intermediate event-only import.
No content traversal is implied. An erased message/root relation does not
revive merely because an older source still has the bytes.

Missing non-erased bytes remain an integrity/availability condition and may
be repaired from a verified folder import or backup. Deferred
`vault-sync/1.0` may later provide another repair source.

### 17.3 Replica synchronization (deferred)

`vault-sync/1.0` is a future profile for encrypted immutable root, event and
DASL-object anti-entropy. It is not required by phase 1 and MUST NOT be started
implicitly by a phase-1 runtime.

### 17.4 Restore

A portable folder restore creates a new local `replica_id` and
`store_generation` unless the operation is an exact move whose old writer is
permanently stopped. The restored runtime derives every mediation and
communication key, reconciles required recipients using ordinary Coordinate
Mediation, drains the account-scoped mailbox, and resumes eligible outbox work.
It also reconciles unfinished committed inbound work under section 16.1,
including observations already pickup-ACKed before the snapshot. Local queue
state is not a recovery source.

No previous process must be online. Mediator retention still bounds messages
that were never committed to the vault. Seed/recovery material must be backed
up independently of the readable event/object folder.

### 17.5 Forked author

If two writable copies accidentally preserve the same local replica ID,
previously unseen same-author events cause `ForkedAuthor`. One copy mints
a new local replica ID and retries merge. Existing events under the old
author remain unchanged.

## 18. Privacy and security boundaries

- Phase 1 has one active full runtime holding the single seed.
- A full runtime may run locally or on a server; process location does not
  confer ownership of a DID.
- `replica_id` and event author are operational provenance, not credentials or
  peer-visible addresses.
- The readable folder contains plaintext retained message content and
  attachments unless surrounding storage encrypts it.
- A rendezvous DID is intentionally disclosed and correlatable within its
  audience. Its Peer long form avoids DNS resolution for that DID; resolving
  an external peer or mediator may still involve a network resolver.
- A relationship DID SHOULD be disclosed only through encrypted interaction
  and MUST NOT appear in a reusable public invitation or discovery document.
- A valid rendezvous-to-pairwise `from_prior` is contact-scoped evidence. It
  MUST NOT globally link pairwise relationships created for different
  contacts.
- The phase-1 mediator stores only encrypted inner DIDComm envelopes and
  routing/account-delivery metadata. It does not receive a replica ID.
- Deferred `replica-mediation/1.0` would reveal opaque replica IDs to the
  mediator; deferred `vault-sync/1.0` would add client-side encrypted opaque
  objects.
- The mediator may observe its account DID, recipient DID and method,
  ciphertext size, arrival, pickup, ACK, expiry, IP and traffic timing. It is
  not sent a contact ID or relationship ID.
- A direct endpoint sees transport metadata and encrypted DIDComm envelopes;
  it is not an application-level runtime address.
- Ultimate ACKs reveal durable-receipt timing to the peer.
- Event authorship does not authenticate one future full replica against
  another malicious holder of the same seed.

## 19. Versioning

These event meanings belong to vault version 3. A version-3 reader may
preserve unknown event types but MUST validate every known type according
to this document.

Compatible additions within version 3 may introduce a new event type or
an explicitly optional payload field whose absence has a fixed meaning.
Changing the meaning of an existing field, fold, deterministic ID,
erasure rule or key derivation requires a new vault version.

There is no migration requirement from an earlier event vocabulary.

## 20. Required conformance cases

1. Every local event has `author == local replica_id` and phase 1 enforces one
   active writer.
2. A server full runtime has the same event semantics as a local full runtime;
   a thin client without seed is not an author.
3. A send commits body, attachments and `message.out` with networking disabled.
4. `message.out` freezes created time, expiry, exact nullable `pleaseAck`,
   exact `ack` and every permitted additional header.
5. Null `pleaseAck` omits the wire header; `[]` emits an empty header and
   requests no explicit message ID.
6. `pleaseAck` containing `""` or the current wire ID requests that message's
   receipt; an array naming only older IDs does not. Neither changes submission
   completion or envelope retention.
7. Standard `please_ack` empty-string and current-ID forms are accepted and
   preserved.
8. `return_route` is rejected in vault application headers.
9. Intent hash covers application ID/type/thread/body/ordered attachments and
   immutable control headers; plaintext hash covers one exact DIDComm
   plaintext.
10. Two packages may differ in valid address/security evidence while agreeing
    on wire ID and intent hash.
11. Retrying one package preserves identical plaintext, envelope and package
    ID.
12. HTTP success produces `delivery.submitted`, never acknowledgment.
13. A deterministic response acknowledges an outbound only when authenticated
    explicit `ack` names its wire ID.
14. Expiry irreversibly ends unsubmitted work. Section 14.8 derives `late`
    from the earliest valid ACK carrier observation `at`, for both submitted
    and expired unsubmitted messages. An observation before expiry is on time;
    equality or later is late. Null expiry is never late. Restart, fold time,
    a later duplicate and delayed `delivery.acknowledged` commit do not change
    an on-time receipt into a late one. No expired failure is needed for a
    submitted message's late receipt.
15. Equal authenticated variants derive one observation MID. Equal wire IDs
    under transition-verified peer keys in one relationship merge only at the
    logical-message layer.
16. Before the first automatic effect, its execution ID derives from the unique
    relationship-or-channel scope and wire ID using committed evidence, not
    an observation MID, contact ID or uncommitted transition.
17. A transition-pending observation is effect-deferred; once verified, a
    cross-key alias in the same relationship derives the same execution ID.
18. Observations sharing one MID but deriving different scopes preserve prior
    history and suppress ACK processing and new effects as an execution-scope
    conflict; different valid local recipient keys cannot cause two executions.
19. Intent conflicts suppress disputed automatic effects and ACK
    processing.
20. Pure Empty ACK, valid initial-response Empty with `pleaseAck == [""]`,
    `ping-response` and valid no-handoff errors obey section 14.7's control
    classification. This includes direct replies and subsequent-attempt handoff
    responses on an already bound relationship, with or without `from_prior`.
    Their explicit ACKs and eligible ACK requests still process; none enters
    thread, unread counts, notifications or application-content handlers. A
    received initial Trust Ping remains an application candidate.
21. Pure ACK has `pleaseAck == null`; it completes when `delivery.submitted`
    commits under the common rule and creates no ACK loop.
22. Duplicate receipt of a message whose requested IDs were already honored
    may resume eligible unsubmitted work from the same frozen response/ACK
    intent. After that intent's `delivery.submitted`, it causes no resubmission
    or replacement effect.
23. Account-scoped Pickup ACK follows durable message/object commit for
    input passing receive and integrity checks.
24. Unlock/recovery-incomplete input and an exact known local key-agreement
    method with a recoverable missing prerequisite remain unacknowledged;
    after key state is authoritative, foreign DIDs, nonexistent/wrong-purpose
    local fragments, retired rendezvous DIDs and terminal bound-route
    dependencies are terminal wrong-recipient input and do not remain pending.
    A retired relationship DID with a valid non-terminal bound route still
    receives normally with unchanged scope; a tombstoned contact requires
    late-message erasure and cannot resume effects or be recreated.
25. Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.
26. `peer.resolved` retains exact canonical document bytes under their raw CID,
    presented/canonical DID forms and selected key IDs, including for external
    `did:web` peers.
27. Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
28. A reusable invitation contains a rendezvous DID and no relationship DID;
    the local Peer path requires no DNS or Web DID.
29. Valid initials have no type, size, lifetime or acceptance-time policy.
    Common syntax, authentication, integrity and resource checks still apply.
30. Trust Ping is supported; unknown application types and missing receipt
    requests do not block durable receipt or materialization.
31. The first bootstrap message is an ordinary application message, not an
    Estoc rendezvous wrapper.
32. A candidate's `myKey` maps to one committed rendezvous DID and its
    `peerResolution` pins the exact sender document. Recovery derives scope
    from those references without an admission decision or extra configuration
    ID; missing evidence defers and inconsistent references conflict.
33. Two initial wire IDs from the same `(rendezvous DID, initiator key)`
    derive one relationship/contact/responder DID and remain separate messages.
    Each consistent committed candidate supplies that scope independently.
34. A deterministic contact tombstone is not resurrected; reconnect requires a
    fresh initiator relationship key.
35. Initial receipt and materialization accept absent or past wire expiry.
    A non-null outbound expiry still stops unsubmitted work at equality.
36. Durable receipt survives restart before materialization and later
    expiry. Current tombstones suppress new work; no new admission command
    is needed to resume a valid candidate.
37. Stable `relationship.established` records the selected origin,
    contact, local DID, peer, handoff MID and exact `fromPrior`. Prior form/kid
    and rotation `iat` derive from the verified JWT; responder long form and
    route derive from the local DID; execution ID and effect key derive from the
    handoff intent.
38. `from_prior.iss` uses the exact invitation/snapshot form and its protected
    `kid` belongs to that exact DID.
39. `from_prior.sub` equals plaintext `from` byte-for-byte; before confirmation
    both use responder Peer-DID long form.
40. The initiator verifies a rotation's `iss` and protected `kid` against its
    binding's exact pinned predecessor snapshot and accepts any integer
    Epoch-Seconds `iat`; neither `iat` nor a fresh resolver result selects a
    snapshot (`rendezvous.md` section 12).
41. Response intent precedes pairwise recipient registration, and registration
    precedes submission.
42. Trust Ping is the default no-content initial message; an application
    message may be first without wrapping.
43. A handoff freezes only eligible requested ACK targets, requests its own
    ACK with `pleaseAck == [""]` and carries frozen `fromPrior`. Missing an
    initial receipt request does not cause rejection or an unsolicited ACK.
44. Human-authored content is ordinary later traffic and does not choose the
    relationship origin or rotation time.
45. Until an authenticated message arrives at responder pairwise DID, every
    package from it carries the same `fromPrior` and uses long-form sender
    spelling.
46. A new input failing known integrity checks creates no durable candidate
    or rejection response. Retained candidates use ordinary erasure rules.
47. Ordinary `writeTo` excludes a local rendezvous sender and permits the
    peer's current pinned or verified DID after qualifying inbound evidence.
    Initial and automatic sends also use local relationship DIDs; no local
    rendezvous-key rejection exception remains.
48. Contact-scoped transition does not globally retire or union the rendezvous
    DID with unrelated relationships.
49. Peer rendezvous and relationship DIDs may use different mediation routes.
50. The desired recipient pair is derived only from a live DID's bound route.
    Registration is queried and reconciled on reconnect and after restore;
    local trace loss does not change that desired set. A retired relationship
    DID is absent from it, but its usable mediation stays in the required
    receiving set while its bound route remains configured and non-retired,
    even when no live DID uses that mediation and it is not preferred.
51. Each local DID derives fixed authentication and key-agreement keys and
    an immutable bound route. Rotation creates another entity; a responder
    selects its independent pairwise route when creating the relationship DID.
52. Erasure is checked before object presence; late roots receive equivalent
    erasure closure.
53. Restore from a readable folder creates a new local author unless it is an
    exact move, reconciles standard mediation/pickup and resumes eligible
    outbox work.
54. Phase 1 requires neither `replica-mediation/1.0` nor `vault-sync/1.0`.
55. Shuffling the same event set leaves every phase-1 fold result unchanged.
56. Closed attachment normalization makes intent hashes independent of
    implementation-selected presentation or diagnostic metadata.
57. ACK before `delivery.submitted` does not complete submission or release an
    otherwise retained package. Committing `delivery.submitted` releases every
    package's delivery retention contribution for that MID without waiting for
    ACK; message body and attachment lifetimes remain separate.
58. Commit and collection share the writer lock; GC computes current held roots
    under that lock and cannot unlink a retained object or overlap acceptance
    and append within a commit.
59. A successfully appended inbound event survives immediate process restart
    before the mediator pickup acknowledgment is sent.
60. ACK-target lookup is scoped by the carrier's stable relationship/channel
    execution scope plus requested wire ID; another peer or relationship using
    the same wire ID is never acknowledged.
61. Every accepted inbound carries a durable phase-1 receipt ordinal. ACK arrays
    use `firstReceiptKey`; clock rollback does not reverse receipt order in a
    linear history, and cross-author ties have deterministic recovery order.
62. The five-field `relationship.initiatorBound` commits from an already
    committed initial package and pinned resolution before first submission.
    It needs no inbound handoff or proof. Restart reconstructs the same scope
    even without a response, after content erasure or after submission and
    envelope collection. Later initial attempts and rotations retain the same
    references. Missing evidence defers; mismatched or ambiguous evidence
    conflicts. A response intent must use the previously committed binding.
63. Later transition-verified aliases/rotations in that relationship reuse the
    same execution ID and cannot execute the same logical wire message twice.
    Detachment or DID/route retirement never selects a new execution scope.
64. Committed submission remains complete after restart, loss of `local/`,
    clock rollback, package retirement, content erasure and envelope collection.
    Retained event skeletons prevent resubmission or replacement of that MID.
65. One package's committed `delivery.submitted` completes its entire MID and
    suppresses every other package's preparation or submission. Workers
    serialize dispatch per MID and commit acceptance before further dispatch.
66. The inbound MID vectors in `distributed-delivery.md` section 9 recompute to
    `369d7a43-8dce-5b86-b073-e390d457f357` and
    `a8b9afd5-60fe-5f49-a669-bd998e760e7e` from their published inputs.
67. Attachment IDs obey DIDComm 2.1 URI-unreserved syntax independently of
    filename or DASL object identity.
68. An otherwise retained unsubmitted package survives route unavailability
    and GC with its exact bytes. Route recovery cannot reopen a submitted MID.
69. Retiring an unsubmitted package releases its delivery retention contribution
    without completing the MID. Retiring a submitted package does not undo the
    MID's committed submission evidence.
70. Shared envelope bytes remain held by another non-erased message even after
    one message/root relation is erased.
71. Each new duplicate observation receives a fresh ordinal; exact re-ingest
    does not. The logical group's minimum complete `(integer ordinal, author)`
    key orders future ACKs without changing any already frozen ACK array.
72. Restore, restart and loss of `local/` recover the ordinal high-water mark
    across all historical authors. Cross-author equal ordinals survive import
    and sort by author on a tie; allocation resumes above the union's maximum.
73. A matching local one-use invitation is consumed at valid candidate
    commit, before materialization. Crash, detach, deletion and erasure do not
    reopen it. Another consumer fails integrity before inbound commit.
74. Responder origin inbound IDs never identify a local outbound by coincidence;
    local handoff and initiator initial outbounds use their exact named MIDs.
75. A known sender DID or submitted initial with missing initiator binding
    does not skip recovery. The binding commits before any required transition,
    and both precede the separate response-intent commit.
76. A pickup-ACKed inbound with unfinished deterministic work is rediscovered
    from portable history on open, without redelivery or a surviving local queue.
77. A known duplicate can record a new receipt observation but cannot
    recreate a tombstoned contact. A conflicting duplicate supplies no new
    executable work; its prior history remains.
78. A no-handoff error uses the initiator's already bound relationship
    scope; its validated pinned-document ACKs prove receipt, not remote
    admission. It generates no automatic response. A later rotation retains
    its historical scope and per-attempt diagnostic rules.
79. A crash after an application candidate commits resumes materialization and
    eligible response work from portable history without another decision or
    redelivery.
80. Distinct events sharing a receipt `(author, ordinal)` pair remain history
    with a projected receipt-integrity conflict, not a full-import failure.
    Only affected logical messages are excluded from newly frozen ACK targets.
81. Every permutation of a fixed event union yields the same minimum complete
    receipt key and scope-local order. Learning an older verified alias may
    change future order, never a previously frozen ACK array.
82. Each consistent durable bootstrap input has deterministic relationship
    scope; unknown application types do not require approval. Integrity
    conflicts suppress effects without creating a replacement scope.
83. Same-consumer invitation reuse does not create another take. Imported
    incompatible consumers leave it unavailable; event order chooses no winner.
84. Adding `contact.merged` changes only display grouping. Per-`cid` decisions,
    relationship scopes, message/execution IDs, ACK results, invitation state
    and deletion/erasure behavior remain unchanged.
85. A matching `pthid` on an ordinary inbound, a foreign local recipient or
    a remote invitation does not consume our disclosure. A valid candidate
    consumes a new one-use invitation even when its relationship already exists.
86. Retryable transport failures and attempt phase/status remain local trace.
    Restoring an outbound with only `message.out` projects `queued` and permits
    eligible retry; durable prepared/submitted/terminal evidence still applies.
    A crash before `delivery.submitted` commits may resend the exact package
    even if transport had accepted it; a crash after commit cannot resend it.
87. A user send or deterministic response uses its outbound MID as plaintext
    `id`; every package and retry preserves it. Inbound observation MIDs remain
    scoped derivations and are not replaced with the received wire ID.
88. A responder chooses its route at pairwise DID creation. Recovery after
    a crash before `did.created` commits may choose a current route; after
    that commit, a partial materialization reuses the same DID and route.
    A preference change or unavailable route never rewrites that entity.
89. Rendezvous retirement and input commit share the writer lock. Retirement
    stops later input, including duplicate observations, but an already
    committed candidate can finish through a live pairwise route. Restore and
    shuffled event import preserve its scope and invitation consumption without
    using timestamps to reconstruct a receive cutoff.
90. A transition names one relationship and matching contact. A shared
    contact, thread, key or prior DID cannot extend it to another relationship.
    The first initiator transition uses its existing binding's pinned snapshot;
    transition evidence commits before its response intent. A different sender
    with no proof remains a separate identity and cannot ACK this relationship.
91. Erasing message content does not remove the DID, origin and handoff event
    skeletons used by `relationship.established`. Restored choices still use
    those references and the exact JWT; a mismatched `iss`, `sub`, `kid` or
    `iat` is a conflict, not authority to select replacement material.
92. Two automatic intents for the same execution, handler, kind and ordinal
    have one effect key and MID. Different intent hashes conflict after any
    permutation of their union; both variants and their packages remain history,
    with preparation and submission suppressed.
93. Equal effect keys and intent hashes with different targets still conflict.
    Exact duplicate intents produce one logical outbound.
94. An automatic intent whose execution ID disagrees with its unique carrier
    group's derived ID, whose key disagrees with that ID or protocol tuple, or
    whose MID disagrees with its key is invalid and cannot execute.
95. Every automatic `message.out` retains `handlerId`, `effectKind` and the
    canonical decimal `ordinal` with its execution ID and key. Reopen can
    recompute the key from those fields; a missing or altered tuple component
    cannot authorize work. A user-authored send has all five fields null and
    `ack == []`; a non-empty ACK cannot bypass deterministic effect selection.
96. After an ACK-bearing response is frozen, a changed handler, effect kind or
    ordinal cannot create another ACK-bearing MID for that execution, even
    after submission or erasure. Importing competing response MIDs keeps
    their history and suppresses all competing responses under every event
    permutation; exact duplicates count once.
97. A valid no-handoff rejection with a unique pinned-document and thread match
    shows its retained reason beside only that initial attempt. Explicit ACK
    adds receipt information; with or without ACK, committed `delivery.submitted`
    stops submission and its absence leaves the existing unsubmitted-work rules
    in force. Duplicate observations show one diagnostic, and permutations give
    the same report order. A report naming several ACK targets does not reject
    them all; ambiguous correlation shows no attempt diagnostic. Restart
    reconstructs the view, body erasure removes
    the diagnostic even if its CID remains elsewhere, and a delayed report
    never overrides an established relationship.
98. An authenticated supported public-DID initial needs no Peer-DID long
    form. Exact spelling and document remain in `message.in` and its named
    resolution; our responder still creates its own pairwise DID and proof.
99. A direct reply on the pinned DID and a later valid rotated alias of the
    same wire message have one relationship execution ID. Reopen, duplicate
    input and another initial attempt do not replace the binding or repeat
    effects; committed submitted outbounds remain complete.
100. A validator rejects a response whose scope exists only in its proposed
     input/binding/transition batch. The prerequisite commits first; candidate
     materialization may share the handoff-intent batch because scope comes
     from the previously committed input.
101. Equivalent supported representations of one public key normalize to the
     exact section-4.1 value. Different key types or public bytes differ.
     Channels, scope comparisons, inbound MIDs, automatic contacts and
     relationship IDs use the complete value. The X25519 key fixture round
     trips to `ec01` followed by the published 32 public bytes.
102. Channel enumeration, first-disclosure validation and recovery use the
     complete keys and presented DID evidence in message/resolution events,
     without a separate channel-creation event. Selecting a recipient key or
     attaching a channel does not prove authenticated inbound traffic.
103. `message.out.initial` is immutable and required, null for ordinary traffic
     and non-null for an initial attempt. A non-null value pins its local DID
     and presented peer DID; conflicting values under one MID conflict even
     when the intent hash matches. Every initial package validates those joins.
104. Before a qualifying scoped inbound, an initiator's pinned peer end accepts
     initial attempts but is absent from ordinary `writeTo`. A direct reply
     enables ordinary sending without rotation. Prepared initial attempts
     remain identifiable after reply, submission, content erasure and restore;
     binding recovery never infers classification from OOB or message type.
105. A successful same-DID resolution with no usable previously evidenced key
     produces only message-scoped `peer-key-changed`, with no incompatible
     package or binding. An authenticated same-DID new-key inbound without
     proof at the old relationship DID stays unscoped and out of the thread,
     unread count and normal notifications. Its contact diagnostic survives
     restart and body erasure; graph attribution never authorizes its ACKs or
     effects. Missing or ambiguous relationship evidence selects no contact.
106. The peer chain includes every key-agreement key in the pinned initial
     document and each verified successor document. A second authorized key
     can reply in the same scope without an origin rewrite; a fresh unpinned
     document cannot add a key. Equal wire messages under these keys merge
     once within that relationship when their intent and package proofs agree.
107. The initiator derives relationship IDs from its own key-agreement key;
     its authentication key cannot substitute. NIST-curve JWK and SEC1
     compressed-point inputs normalize to the same canonical `peerKey`.
108. First-package preparation for each new non-numalgo-4 outbound performs
     fresh resolution. Retry and permitted repack use retained evidence;
     neither an old snapshot nor a local TTL bypasses the new-MID rule.
     Every new non-numalgo-4 inbound observation also requires current sender
     authentication under `rendezvous.md` section 5.1; a chain member absent
     from the current document fails, and unavailable resolution defers
     without pickup ACK. Committed observations recover from their retained
     evidence without new resolution or retroactive scope changes.
109. Control candidates retain their derived relationship scope but select
     no origin, handoff, contact or DID, including after restart. Any eligible
     receipt ACK follows `distributed-delivery.md` section 8.1's sender gate
     and generic profile with `pleaseAck == null`.
     No-handoff errors generate no response; unmatched or invalid Empty,
     `ping-response` and Report Problem input cannot trigger materialization.
110. An input received at an eligible retired local relationship DID retains
     scope and durable receipt. Without a usable current local end it commits
     no deterministic reply/ACK intent and consumes no ACK-bearing selection.
     Creating a valid live successor makes that unfinished work recoverable;
     it replies in the same relationship, never another one of the contact.
111. `message.in` and `message.prepared` have no `peerKey` payload member.
     Channels, MIDs and package comparisons derive it through `peerResolution`.
     Missing non-null references defer, mismatched evidence conflicts, and only
     an anonymous inbound has null resolution/peer key. Explicit channel and
     peer/attachment/profile/ACK event keys remain present.
112. A local transition commits its UUIDv7 successor, preference and exact
     proof atomically. Restore reuses the chosen route, keys, `iat` and JWT;
     a later mediation preference cannot replace them. The initial binding,
     `ourDid`, relationship ID and peer chain remain unchanged.
113. Before a local edge, the predecessor's disclosure is confirmed by scoped
     inbound at that exact DID. An initiator also needs a verified peer end
     beyond its original rendezvous address. A second local edge waits for
     confirmation of the first and uses that successor's long form and signing
     key as predecessor; short-form traffic does not replace the proof pin.
114. Until successor confirmation, new packages use its long form and exact
     frozen proof. Receipt at a predecessor cannot confirm it; a pure ACK at
     the successor can, independently of which outbound it explicitly ACKs.
     The rotating operation keeps a previously live predecessor and its route
     and mediation through confirmation, without retiring shared resources.
115. After a local edge, unsubmitted ordinary contact outbounds repack from
     the current local end with the same MID, intent and ACK targets; old
     packages cannot be submitted. Initial and explicit-channel intents pinned
     to a superseded key fail with `local-did-rotated`. Submitted MIDs never
     reopen, and later retirement never selects a prior chain member to send.
116. Equal local edges are duplicates. Branches, different proofs for one
     predecessor, cycles or a cross-relationship local DID conflict under every
     import permutation. Missing predecessor/document/proof evidence defers;
     neither case permits new effects by ignoring the problematic edge.
117. Local predecessor and successor keys retain the same relationship scope
     and outbound ACK membership under `distributed-delivery.md` section 9's
     local-rotation vector. A contact preference cannot attach an unrelated
     local DID to that chain or make an automatic response cross relationships.
