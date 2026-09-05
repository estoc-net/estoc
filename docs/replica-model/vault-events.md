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
6. **At-least-once is expected.** Process restart, transport retry and mailbox
   redelivery may repeat work. Folds and handlers must be idempotent. Future
   multi-runtime execution must preserve the same identifiers.
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
`did:peer:4` entity and an explicit scoped transition. There is no local
communication-key generation or key-generation selection. Store generations
and rendezvous generations retain their separate storage and admission-policy
meanings.

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
| `automatic-wire-id` | `236a6e18-9271-59c8-9a0c-f940a0f8dc6f` |
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
- `peerKey` is the fingerprint of the authenticated peer public key, or
  `null` for an anonymous sender.

Both fields MUST be present on every channel observation. JSON null is a
value; an omitted field is invalid.

The peer-key fingerprint is:

```text
base32lower(
  SHA-256(multicodec-prefixed raw public key bytes)
)[0:26]
```

The complete public key appears in `channel.firstSeen`; the short
fingerprint is only the stable grouping value.

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

### 4.3 `channel.firstSeen`

```json
{
  "type": "channel.firstSeen",
  "roots": [],
  "data": {
    "myKey": "did/019b2a45-8381-793f-943c-f5d806fd5ca2/key-agreement",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "peerPublicKey": "did:key:z6LS...",
    "kind": "authcrypt",
    "firstDid": "did:peer:4zQm...short:z...input-document"
  }
}
```

`kind` is one of:

```text
authcrypt
anoncrypt
signed
```

`firstDid` is the exact DID spelling presented when the channel was first
observed, or null when none was presented. A Peer DID numalgo-4 first
disclosure therefore records its long form here and its canonical short form
through `peer.resolved`.

A replica appends this observation when it first encounters a channel
for which the converged vault has no equivalent observation. Concurrent
duplicates are harmless. If one `peerKey` is associated with different
public-key bytes, the channel fold reports an integrity conflict.

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
old and new DIDs and routes to overlap during cutover.

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
A phase-1 one-use OOB invitation MUST disclose a rendezvous DID; its final
acceptance consumes it under section 14.10.

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

An envelope that still arrives for a retired key may be durably recorded
before policy rejects further interaction; retirement is not retroactive
erasure. Historical events, key derivation and contact-scoped transition
evidence remain.

## 6. Identity metadata

### 6.1 `identity.label`

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

`because` is `user` or `automatic`. An automatic event also SHOULD carry its
deterministic `effectId` when the schema-producing procedure has one. For a
stable rendezvous contact, an initial-message-specific protocol effect ID MUST
NOT be copied here: later initial messages share the contact. Such an
event either omits `effectId` or uses a separately defined relationship-stable
creation effect.

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

A normal established contact SHOULD use a relationship DID. A rendezvous DID
may be used only for bootstrap or another protocol that explicitly permits
rendezvous-addressed communication. This event
says nothing about an authenticated peer channel.

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
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
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
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa"
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
transitions, message or execution identity, ACK scope, admission, invitation
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

- `mid` is the vault message entity ID.
- `wireId` is the innermost DIDComm plaintext `id`.
- `packageId` identifies one exact encrypted inner envelope and is Routing
  2.0 `forward.id`.
- mediator `deliveryId` is not stored by outbound events.

A user send mints independent UUIDv7 `mid` and `wireId` values.

An automatic effect derives:

```text
mid = UUIDv5(
  8847bd57-5907-5bcd-9a71-d1e97cee3199,
  RFC8785(["v1", effectId])
)

wireId = UUIDv5(
  236a6e18-9271-59c8-9a0c-f940a0f8dc6f,
  RFC8785(["v1", effectId])
)
```

Concurrent replicas executing the same effect therefore emit one logical
response.

### 9.2 `message.out`

```json
{
  "type": "message.out",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "wireId": "019b2a71-0a11-72a8-8cb2-9cae8cd9e111",
    "target": {
      "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da"
    },
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
    "replayUntil": null,
    "executionId": null,
    "effectId": null
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

A contact target may select a rendezvous DID only for an initial-message send
under `rendezvous.md`. Ordinary relationship messages never select a
rendezvous DID. A peer-key-null channel cannot be used for an authenticated
reply.

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
- `replayUntil` is an Epoch-Seconds integer or null, controls only exact
  duplicate-response retention and is excluded from the wire and intent hash;
- `executionId` and `effectId` are both null for a user-authored send and both
  non-null for an automatic effect;
- `thid`, `pthid`, `expiresTime`, `replayUntil`, `executionId` and `effectId`
  are present with null when unused; and
- appending this event requires no network, resolver, mediator or socket.

A deterministic response that may have to replay exact bytes after duplicate
receipt MUST set `replayUntil` according to `distributed-delivery.md` section
7. A preparer emits `created_time`, `expires_time`, `thid` and `pthid` only when
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
    "wireId": "019b2a71-0a11-72a8-8cb2-9cae8cd9e111",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "senderDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
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

- `senderDid` names a live local DID entity selected for the target;
- `myKey` is that entity's key-agreement key and authorizes the plaintext
  `from` under the exact spelling used by the package;
- the plaintext `id`, semantic fields and immutable control headers equal
  `message.out`;
- `intentHash` equals the intent value;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- `peerResolution` names the exact `peer.resolved` evidence used to select
  the recipient key, or null only when the channel was already durably
  established without a fresh resolution requirement;
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization. The `envelope` CID commits to those exact bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

All packages for one `mid` MUST preserve its intent hash. A new package MAY
change `senderDid`, `myKey`, `recipientDid`, `peerKey`,
`peerResolution` or `fromPrior` only when the change follows a valid selected
DID entity or verified contact-scoped continuation for the same logical target.
Every such change requires a new package ID and plaintext hash. A protocol may
be stricter; one initial-message wire ID pins the rendezvous DID snapshot and
recipient key.

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

`replacement` is nullable. Retirement permanently stops normal automatic
submission of this package; it does not terminate the logical message or
another package. Its envelope contribution is determined only by section
15.3's retention predicate. A null `replayUntil` requires no replay closure;
for a non-null replay obligation, retention continues until valid closure
unless explicit message/root erasure overrides that contribution. Wall time
alone never releases a retained root; erasure does not itself close replay.

### 9.5 `message.replayClosed`

```json
{
  "type": "message.replayClosed",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "replayUntil": 1789652400,
    "because": "deadline"
  }
}
```

This event is the portable monotonic closure of exact-response replay.
`replayUntil` MUST equal the non-null value frozen in `message.out`. `because`
is `deadline` or `erased`.

For `because == "deadline"`, the runtime MUST have observed an instant greater
than or equal to `replayUntil`. For `because == "erased"`, corresponding
portable `message.erased` evidence covering the replay-only roots MUST already
be committed or be committed atomically in the same `appendAll`; this form may
close replay before the deadline.

Once any valid `message.replayClosed` exists for an outbound, replay material
is closed permanently. Restart, loss of `local/`, wall-clock rollback, later
holds/releases, transport retry state or a later duplicate observation MUST
NOT reopen the obligation or require a replacement package. A deadline-based
worker MUST append this event process-durably before GC may release roots held
only for duplicate replay.

### 9.6 `delivery.submitted`

```json
{
  "type": "delivery.submitted",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "transport": "https",
    "endpoint": "https://mediator.example/didcomm",
    "status": 202
  }
}
```

This says only that one transport endpoint accepted the attempt. It does not
mean route existence, mediator retention, pickup or ultimate durable receipt.
Concurrent observations through different routes are expected.

### 9.7 `delivery.failed`

```json
{
  "type": "delivery.failed",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "scope": "message",
    "packageId": null,
    "phase": "prepare",
    "code": "expired",
    "retryable": false
  }
}
```

`scope` is `package` or `message`; `phase` is `resolve`, `prepare` or
`submit`. `packageId` is REQUIRED for package scope and null when no package
exists.

- `retryable == true` is diagnostic state used by retry policy.
- package-scoped `retryable == false` makes that package terminal but permits
  another valid package for the same message.
- message-scoped `retryable == false` stops all automatic preparation and
  submission for the intent.
- `code == "expired"` MUST be message-scoped and non-retryable.

A worker that observes `now >= expiresTime` before prepare or retry appends
that expired failure and submits nothing. A later user attempt requires a new
`message.out` and wire ID. Sensitive strings remain in local trace; `code` is
a stable non-secret value.

### 9.8 `delivery.held`

```json
{
  "type": "delivery.held",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "because": "user"
  }
}
```

`because` is `user` or `policy`. A hold stops automatic preparation and
submission vault-wide. There is no imported hold.

### 9.9 `delivery.released`

```json
{
  "type": "delivery.released",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "hold": "019b2a78-76b3-7ea0-abd1-4cb3537c48fd"
  }
}
```

`hold` names one `delivery.held` event. A message remains held while at least
one exact hold has no release; wall-clock ordering is irrelevant.

### 9.10 `delivery.acknowledged`

```json
{
  "type": "delivery.acknowledged",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "wireId": "019b2a71-0a11-72a8-8cb2-9cae8cd9e111",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "<alice-pairwise-key-fingerprint>",
    "ackMid": "27c4471f-8937-501b-9ffb-a7eaeeebc178",
    "ackWireId": "21559fb4-1a9f-54b1-b8fa-1bf82700d365"
  }
}
```

This event is appended only after an authenticated ultimate peer plaintext
contains `wireId` in its explicit DIDComm `ack` array and every package-level
address, transition and protocol-specific security precondition for that ACK
has validated. Threading or a natural response without `ack` is insufficient.
`ackMid` identifies the local inbound ACK-bearing observation.

One valid acknowledgment stops automatic retry of every package for the
logical outbound. Duplicate observations are harmless. A valid ACK received
after local expiry is retained and derives an `acknowledged` outcome with a
`late` indicator; it does not restart any expired work. Acknowledged means
durable receipt by the peer vault, not read or business acceptance.

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
    "mid": "29370ccd-932b-51eb-9cc3-4c083adc151a",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "receiptOrdinal": "42",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
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
- `peerKey` is the authenticated sender fingerprint or null for anonymous;
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
receiptOrdinal)` are a receipt-integrity conflict. Retain those events and
surface the conflict; do not use their affected logical messages as newly
frozen ACK targets. Unaffected messages remain processable. Full import MUST
NOT reject an event union merely for receipt-ordinal reuse or this projected
conflict. The generic event store remains payload-opaque. Its section 5.3
`ForkedAuthor` check detects unseen events under the current local author; it
does not prove that every historical author is fork-free.

The active runtime appends this event only after retained objects are durable.
Only then may it ACK the account-scoped mediator delivery. Ciphertext that
cannot yet be decrypted or mapped to locally available key material produces
no `message.in` and no pickup ACK; it remains a local deferred delivery and is
retried after local state changes.

The rendezvous pre-vault exception is defined in `rendezvous.md`: a safely
classified hard rejection received through Message Pickup MUST be pickup-ACKed
without `message.in`. That exception does not apply to admitted candidates or
ordinary relationship traffic.

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

1. their authenticated peer DIDs/keys are joined by a verified
   relationship-scoped `peer.transitioned` chain;
2. the intent hashes agree;
3. every package-level address and transition proof validates; and
4. neither group is already conflicted.

This transition-aware merge permits a sender to repack one logical wire
message after an authenticated key/DID continuation without displaying it
twice. Reuse of the same wire ID by an unrelated key, another relationship or
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

It remains a durable `message.in` observation and its validated ACK side
effects are processed, but it is excluded from conversation/thread display,
unread counts, user notifications and application-content handlers. Invalid
empty-message variants are not treated as pure ACKs.

Anonymous senders can intentionally reuse wire IDs, so applications SHOULD
apply stricter replay and automatic-handling policy to them.

### 10.4 `message.executionBound`

```json
{
  "type": "message.executionBound",
  "roots": [],
  "data": {
    "executionId": "feeae3f7-34ea-5ff1-b449-0ef76a7375c7",
    "wireId": "019b1b61-3444-7190-9db5-1cc9c215eb23",
    "scope": {
      "relationship": "73a7d8f5-3523-5802-9b65-02da2078273e"
    },
    "observations": [
      "206bcd7e-7320-5512-bbdb-a4d19331d58e"
    ],
    "because": "first-effect"
  }
}
```

This event binds inbound observation identities to one deterministic logical
execution identity. `because` is `first-effect`, `verified-alias` or `ack`.
`observations` is a non-empty, lexicographically sorted, duplicate-free array
of existing conflict-free inbound MIDs.

Use `ack` when binding a carrier to apply an explicit ACK, interpret its ACK
request, or bind an older requested target without an application effect. It
also covers a carrier for which validation leaves no eligible ACK target.
The reason is provenance only: it changes neither identity nor proof or scope
requirements. Otherwise compatible bindings do not conflict merely because
their reasons differ. A binding does not assert that a handler actually ran.

`scope` is exactly one of:

```json
{ "relationship": "<relationship ID>" }
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

The relationship form is used for final accepted responder-side rendezvous
candidates and established relationship traffic. The channel form is only for
a durable non-relationship channel whose protocol forbids cross-key aliasing,
including the final rejection's fixed bootstrap control scope defined in
`rendezvous.md` section 13. An undecided candidate receives no provisional
application execution scope merely because its `message.in` has committed.

The required derivation is defined by `distributed-delivery.md` section 9.

A later observation in the same relationship and with the same wire ID derives
the same execution ID even when it uses a transition-verified peer key. Another
binding may add that MID to the same execution identity. The first binding does
not choose an observation MID as permanent identity.

An observation without a stable valid scope is not effect-eligible. It remains
pending until relationship or channel evidence establishes a scope. A binding
with the wrong derived ID, a different wire ID or a different scope is an
execution-identity conflict. Existing effects remain history, but new effects
are suppressed.

### 10.5 Pickup versus ultimate acknowledgment


Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; each target in its validated `ack` array is resolved only as
`(carrier logical peer scope, wireId)`. A conflict-free local outbound in that
same relationship or exact non-transitioning channel scope may produce an
idempotent `delivery.acknowledged`. A wire ID reused by another peer or
relationship is never selected. Outbound membership is derived by section
14.9. A threaded or natural response without an explicit `ack` array does not
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
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
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
- `authenticationKids` and `keyAgreementKids` are context, not independent
  evidence that every listed key controlled the observed message; and
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
    "scope": "relationship",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "<alice-pairwise-key-fingerprint>",
    "from": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
    "presentedFrom": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document",
    "to": "did:peer:4zQm...alice-pairwise-short",
    "presentedTo": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
    "fromPrior": "eyJ...",
    "priorResolution": "019b4d11-22d3-7fd0-82fb-f33864a75dd4",
    "mid": "3e7a2368-4a71-5560-8785-348ca4fbf548"
  }
}
```

This event is lifted only from a valid DIDComm `from_prior` in the named
inbound message.

- `scope` is exactly `relationship` in version 3.
- `contact` is REQUIRED.
- `from` is the canonical prior DID.
- `presentedFrom` is byte-for-byte equal to `from_prior.iss`.
- the protected JWT `kid` has a DID portion byte-for-byte equal to
  `presentedFrom` and is authorized by the named historical resolution;
- `to` is the new canonical DID; for Peer DID numalgo 4 it is the short form;
- `presentedTo` is byte-for-byte equal to `from_prior.sub`, plaintext `from`
  and the DID portion of authcrypt `skid`; it is the valid long form on first
  disclosure;
- `priorResolution` names the exact `peer.resolved` event whose document and
  authentication method verify `fromPrior`; and
- `mid` is the actual inbound message entity carrying the proof.

The verifier MUST use the named historical resolution snapshot. A network
fetch of a newer `did:web` document is not a substitute unless the raw CID of
its canonical bytes exactly matches the pinned document CID. Missing snapshot
material creates a retryable deferred state; an invalid signature, claim, key
or long form is a conflict.

The processing procedure attaches the new authenticated channel to the named
contact, preferably in the same `appendAll`. The transition changes the
current peer end only in that contact. It does not globally union the public
DID with every pairwise DID and does not retire `from` for unrelated peers.

A later valid transition may continue from `to` inside the same contact.
Competing current ends are surfaced as a relationship conflict; canonical time
does not choose one. The compact JWT is evidence, not an object reference.

### 11.3 `profile.nameClaimed`

```json
{
  "type": "profile.nameClaimed",
  "roots": [],
  "data": {
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
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
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "wireId": "019b2a85-090f-75a4-beb3-8440780d46e9"
  }
}
```

This observes that our profile was sent on the channel. Duplicate lifted
observations are harmless.

## 12. Rendezvous and relationship observations

These events lift durable state defined by the profile in `rendezvous.md`.
Rendezvous DIDs, relationship DIDs and rendezvous generations are vault-scoped.
A server runtime has no special ownership.

### 12.1 `rendezvous.generationConfigured`

A rendezvous generation freezes admission and handoff policy for one immutable
Peer rendezvous DID entity:

```json
{
  "type": "rendezvous.generationConfigured",
  "roots": [],
  "data": {
    "id": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "relationshipRoute": "019b2a58-75ab-7880-a7d2-c677b6b3bfd1",
    "initialMessageTypes": [
      "https://didcomm.org/trust-ping/2.0/ping",
      "https://didcomm.org/basicmessage/2.0/message"
    ],
    "admissionPolicy": "ask",
    "maxInitialMessageLifetimeSeconds": 604800,
    "maxInitialPlaintextBytes": 65536,
    "autoLimits": null
  }
}
```

The named DID has role `rendezvous`. Its long form, decoded document, fixed
authentication and key-agreement methods, and sole ingress `boundRoute` are
obtained from that immutable DID entity under section 5.2. The generation does
not copy them or select different keys. `relationshipRoute` is independent of
that ingress route and is encoded only in responder relationship DIDs.

Every rendezvous generation freezes:

- the referenced DID entity;
- the independently selected route encoded into responder relationship DIDs;
- `initialMessageTypes`, a non-empty post-admission policy set that MUST
  include Trust Ping `ping`;
- an initial-message lifetime ceiling of at least 604800 seconds;
- an initial plaintext safety ceiling of at least 65536 canonical UTF-8 bytes;
  and
- admission policy and auto-admission limits.

`admissionPolicy` is `ask`, `auto` or `silent`. `ask` is the default. `auto`
requires implementation-documented positive `autoLimits`; `ask` and `silent`
use null. `silent` finalizes reject without selecting a response.

The event is appended before disclosure and does not alone make the generation
live. The referenced DID's long form, fixed keys and bound route MUST validate,
and a mediated bound route MUST be currently reconciled. No document publication
is required. An established relationship retains its exact `originGeneration`
so later policy configurations do not change its frozen handoff material.

A configured generation that can still become live is deferred. A retired or
permanently invalid generation is terminal.

### 12.2 `rendezvous.generationRetired`

```json
{
  "type": "rendezvous.generationRetired",
  "roots": [],
  "data": {
    "id": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "admitUntil": 1789047600
  }
}
```

The generation admits no initial message received at or after `admitUntil`.
Retirement is terminal. A candidate remains admissible only when it is
unexpired, within the configured maximum lifetime and arrived before
`admitUntil`; an old `created_time` alone is not a clock-skew failure.

Private keys and Peer long-form/document evidence remain available through at
least:

```text
maximum initial-message lifetime
+ mediator message retention
+ configured delivery safety margin
```

Pinned packages and historical `from_prior` verification continue to use
retained evidence. Emergency compromise policy may intentionally shorten this
availability.

### 12.3 `relationship.admissionDecided`

This event records a local decision about one durable bootstrap candidate. It
does not define or require a DIDComm response type.

```json
{
  "type": "relationship.admissionDecided",
  "roots": [],
  "data": {
    "inboundMid": "ca6f6a41-454c-53ff-b827-1797156687cf",
    "inboundWireId": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "inboundCreatedTime": 1788442800,
    "inboundExpiresTime": 1789047600,
    "initialMessageType": "https://didcomm.org/trust-ping/2.0/ping",
    "rendezvousDid": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "rendezvousDidValue": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
    "generation": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "initiatorDid": "did:peer:4zQm...initiator-short",
    "initiatorLongForm": "did:peer:4zQm...initiator-short:z...initiator-input-document",
    "decision": "accept",
    "because": "user",
    "code": null,
    "relationship": "73a7d8f5-3523-5802-9b65-02da2078273e"
  }
}
```

- `decision` is `accept` or `reject`.
- `because` is `user` or `policy`.
- `generation` is the live rendezvous generation that admitted the candidate
  through its DID's fixed key-agreement method.
- `initialMessageType` exactly equals the admitted `message.in.msgType`.
- `initiatorDid` is the canonical Peer DID numalgo-4 short form.
- `initiatorLongForm` is its validated first-disclosure long form.
- `inboundCreatedTime` and `inboundExpiresTime` equal immutable wire headers.
- accept requires the deterministic relationship ID.
- reject requires `relationship == null`.
- `code` is null or a non-empty, stable, non-secret diagnostic string.
  Like `because`, it is provenance only and is excluded from final-result
  equivalence. It does not select or change a peer-visible response.

The event `at` is parsed as an RFC 3339 instant. An accept is timely only when:

```text
decisionInstant = parseRFC3339(event.at)
expiryInstant   = UnixEpoch + inboundExpiresTime seconds
timely          = decisionInstant < expiryInstant
```

Equality is expired. A candidate reaching expiry before acceptance may only
receive a new reject decision.

Section 14.5 is the sole normative admission reducer. In phase 1 this event is
a final result, not a provisional policy suggestion. A pending user review
leaves the candidate undecided. Finalization is serialized, and a writer MUST
NOT append a different final result for the same candidate. An existing final
accept is reused after restart even if current time has since passed expiry;
its original decision instant remains the timeliness evidence.

A local admission decision does not require an application execution binding.
Any subsequent deterministic peer-visible effect still requires its validated
execution scope and committed intent. Ending an accepted relationship uses
`contact.deleted`, DID retirement and route unregistration, not a replacement
admission result.

The decision does not prescribe a wire message. Rejection may be silent or may
produce a deterministic protocol error or Report Problem. Acceptance uses only
a deterministic response defined by `rendezvous.md`; human-authored content is
ordinary later traffic.

Reuse of one `peerKey` under another canonical `initiatorDid` for the same
stable relationship is a sender-DID conflict and cannot rewrite the remote
DID.

### 12.4 `relationship.established`

```json
{
  "type": "relationship.established",
  "roots": [],
  "data": {
    "id": "73a7d8f5-3523-5802-9b65-02da2078273e",
    "contact": "48bab320-8759-5579-b78b-531083d49d4c",
    "rendezvousDid": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "rendezvousDidValue": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
    "originGeneration": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "originInboundMid": "ca6f6a41-454c-53ff-b827-1797156687cf",
    "originWireId": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "originCreatedTime": 1788442800,
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "theirDid": "did:peer:4zQm...initiator-short",
    "theirLongForm": "did:peer:4zQm...initiator-short:z...initiator-input-document",
    "ourDid": "2a61bb7e-1578-57ea-83a1-80454032c781",
    "ourLongForm": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
    "route": "019b2a58-75ab-7880-a7d2-c677b6b3bfd1",
    "priorPresentedDid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document",
    "priorAuthenticationKid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document#auth-0",
    "rotationIat": 1788442800,
    "fromPrior": "eyJ...",
    "handoffExecutionId": "e5d6c70d-ee4c-5dd5-9a02-02e0726e55da",
    "handoffEffectInputHash": "9bPd4ZBv7IxjxhZaqz6bRDJxP8lBJC6uPa4ZR0DRhTg",
    "handoffEffectId": "sq5uy24l9qX5IJRYZVxAauKDZeF-ucjEkXUY0SqJbOs",
    "handoffMid": "3ef178eb-d708-5157-b1be-94f5ad0185c7",
    "handoffWireId": "07c45e7a-5fef-5542-817b-d4ba69a16d96"
  }
}
```

This event freezes responder relationship state for
`(rendezvousDidValue, peerKey)`. Different initial message IDs or protocol
types from the same authenticated initiator key reuse the same relationship,
contact, responder relationship DID and route while remaining separate
application messages.

Before this event exists, the active phase-1 runtime selects the origin as the
first effective accepted candidate it is about to materialize. The event then
freezes that origin, the exact prior-DID spelling and authentication method,
the responder long form, relationship route, rotation instant, compact
`fromPrior` and deterministic handoff response IDs. Later candidates cannot
rewrite those fields.

Normative rules:

- `rotationIat == originCreatedTime` and denotes the relationship rotation
  instant, not the creation time of every later response;
- `fromPrior.iss == priorPresentedDid` byte-for-byte;
- the JWT protected `kid == priorAuthenticationKid` and its DID portion is
  byte-for-byte equal to `priorPresentedDid`;
- `fromPrior.sub == ourLongForm` byte-for-byte;
- every package carrying this proof uses `ourLongForm` as plaintext `from` and
  as the DID portion of `skid`/decoded `apu`;
- `theirDid` and `theirLongForm` are the canonical and presented initiator DID
  from the origin candidate;
- `route` is the independently selected relationship route and need not equal
  the rendezvous ingress route; and
- `handoffExecutionId` is derived from the relationship scope and
  `originWireId`, then committed in a binding that includes
  `originInboundMid`;
- `handoffEffectInputHash` and `handoffEffectId` validate under `distributed-delivery.md` section 11; and
- the handoff IDs name one valid deterministic `message.out` for
  `originInboundMid` that explicitly ACKs `originWireId`, requests its own ACK
  with `pleaseAck == [""]`, and freezes a replay deadline.

The inbound `message.executionBound`, relationship, deterministic contact,
channel attachments, `contact.useDid`, responder `did.created`, this event and
handoff `message.out` SHOULD be appended in one process-durable batch. Equal
statements are duplicates; different values under one relationship ID are an
integrity conflict. A separately committed final accept remains final while
this materialization is recovered; it is not replaced by an expired rejection.

A future multi-writer profile must coordinate origin selection before it can
claim convergence. Phase 1 has one active writer, so no remote race chooses a
different origin.

The responder repeats the exact stored `fromPrior` on every package from
`ourDid` until it receives an authenticated message addressed to `ourDid`.
Receipt-required handoff retry ends only after explicit ACK or another
terminal state.

### 12.5 `relationship.initiatorBound`

The initiator commits one portable relationship-scope binding after validating
the responder handoff and before generating the confirmation ACK effect.

```json
{
  "type": "relationship.initiatorBound",
  "roots": [],
  "data": {
    "relationship": "73a7d8f5-3523-5802-9b65-02da2078273e",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "ourDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "ourPresentedDid": "did:peer:4zQm...bob-short:z...bob-input-document",
    "ourKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "initialMid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "initialWireId": "019b2a71-0a11-72a8-8cb2-9cae8cd9e111",
    "rendezvousPresentedDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "rendezvousDid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
    "resolution": "019b4d11-22d3-7fd0-82fb-f33864a75dd4",
    "handoffMid": "3e7a2368-4a71-5560-8785-348ca4fbf548",
    "peerDid": "did:peer:4zQm...alice-pairwise-short",
    "peerPresentedDid": "did:peer:4zQm...alice-pairwise-short:z...alice-pairwise-input-document",
    "fromPrior": "eyJ..."
  }
}
```

This event is initiator-side durable evidence that one validated handoff
continues the exact relationship initiated from `ourDid` toward the pinned
rendezvous snapshot. The `relationship` value MUST equal the deterministic
relationship derivation over the canonical rendezvous DID and the initiator's
own relationship key fingerprint, using the same namespace and formula as the
responder.

Validation requires the named outbound initial intent, its pinned resolution
evidence, the initiator's own relationship DID/key, the named inbound handoff,
and the already validated contact-scoped `peer.transitioned`. The binding is
immutable across later responder key rotations. A restart after this event can
therefore reconstruct the same relationship execution scope without falling
back to a non-relationship channel scope.

In this Bob-local example, the fingerprint used to derive `relationship` is
Bob's own `k3j9n0m4x6q2w7c8v5p1d8s0fa`, not the remote Alice pairwise key.
The Bob-local examples in sections 9.10 and 11.2 use the explicitly schematic
`<alice-pairwise-key-fingerprint>` for that remote key. Those illustrative
message IDs are not additional executable MID vectors; `distributed-delivery.md`
section 9 owns the executable observation-ID vectors.

Before processing the handoff ACK or creating the confirmation effect, the
initiator MUST complete the mutually consistent transition, relationship and
execution evidence under `rendezvous.md` section 12. All missing locally
produced facts in that sequence MUST commit in one `appendAll`. A known peer
DID does not prove that either binding exists. Reopen and imported-prefix
recovery reuse consistent facts and complete missing facts before effects.

## 13. Automatic effects

`distributed-delivery.md` section 11 defines effect identity and commit ordering;
section 8.2 there owns the pure-ACK vector. Section 9.1 of this document defines
outbound MID and wire-ID derivation. `rendezvous.md` section 11.1 owns the
handoff response vectors.

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

The **required receiving set** is every usable mediation that is either:

- preferred; or
- referenced by the mediated `boundRoute` of a live DID under section 14.4.

The active runtime reconciles recipients and drains account-scoped pickup on
every reachable mediation in this set. A hosted runtime receives no special
ownership.

### 14.4 Route, DID and key fold

For each route ID:

- exactly one consistent `route.configured` defines the reusable transport;
- any `route.retired` makes it terminal; and
- conflicting configuration values make it unusable and visible as a
  conflict.

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
Ambiguous or inconsistent mapping is an integrity conflict and prevents
cryptographic use.

### 14.5 Rendezvous and relationship fold

For each rendezvous generation, require one consistent
`rendezvous.generationConfigured` and valid DID/route dependencies. It is live
when its referenced DID is live, that entity's long form and decoded input
document match its fixed keys and bound route, and a mediated bound route is
currently reconciled. The generation contributes policy, not another copy of
DID or key state.

`rendezvous.generationRetired` supplies terminal `admitUntil`. Deferral is
allowed only when the recipient `kid` has already been mapped to an exact
known local key-agreement method and a concrete recoverable dependency for
that method is missing, or while unlock/recovery has not yet made the local key
index authoritative. A configured rendezvous generation that can still become
live is deferred and leaves mediator delivery unacknowledged.

After local recovery is authoritative, a foreign DID, a local DID with a
nonexistent or wrong-purpose fragment, a terminal rendezvous generation, or a
recipient set with no exact local key-agreement mapping is a terminal pre-vault
wrong-recipient rejection. It is not indefinite pending state.

Group `relationship.admissionDecided` by `inboundMid`. Discard structurally
invalid decisions and accepts whose parsed RFC 3339 event `at` is not strictly
before the Epoch-Seconds inbound expiry.

This is the sole phase-1 admission reducer. The active writer serializes
finalization and commits one final `accept` or `reject` result per candidate.
Policy evaluation and user review happen before this commit; an `ask`
candidate is undecided, not provisionally rejected.

Equivalent final results are idempotent. Equivalence requires all payload
fields except provenance `because` and `code` to agree: the decision,
relationship ID and candidate evidence remain semantic. A writer MUST reject
an attempt to append a different final result. Incompatible imported results
are a visible admission conflict: no new acceptance, rejection or application
effect may be emitted. Existing effects remain immutable history; a conflict
does not undo them.

An **effective admission result** is the unique valid final-result equivalence
class for a candidate under this section. An undecided candidate or a candidate
with an admission conflict has no effective result. References to effective
accept or reject mean that result, not merely the presence of a final event.

An effective accept authorizes the existing materialization procedure. An
effective reject authorizes candidate-only erasure once any selected rejection
intent has been frozen. The decision and any chosen rejection intent/binding
commit atomically under `rendezvous.md` section 9.3. Recovery resumes committed
response work and erasure; it neither invents an uncommitted optional response
nor reopens the decision. No final result can be replaced by later user
approval, policy reevaluation or an expiry observation. A new attempt requires
a new initial message and wire ID. Relationship termination uses contact and
DID lifecycle operations, never a retroactive admission rewrite.

Before final accept, the writer checks the one-use invitation rule in section
14.10, deterministic contact tombstones and sender-DID consistency. These
checks and acceptance commit share one serialized finalization operation.
An undecided candidate introducing a new consumer of an unavailable one-use
invitation is finalized as reject under `rendezvous.md` section 9.3.
Recovery of an existing final accept and permitted reuse by the same consumer
do not create another consumer or rewrite a result. Rejection never creates a
custom rendezvous decline.

Group responder-side `relationship.established` and initiator-side
`relationship.initiatorBound` by deterministic relationship ID. Each side must
validate its own closed schema and derivation. Equal evidence is one
relationship; incompatible evidence for one ID is an integrity conflict. A
responder event freezes origin, generation, remote DID, route, rotation proof
and handoff IDs. An initiator binding freezes its initial outbound, pinned
rendezvous evidence, local initiator identity, validated handoff and responder
pairwise DID. These values are not re-selected from later arrivals.

A valid relationship contributes:

- one contact: deterministic for the responder, or the retained existing
  contact named by the initiator binding;
- authenticated bootstrap channels;
- the pairwise relationship channel;
- one local relationship DID and route;
- one canonical remote Peer DID; and
- zero or more later deterministic protocol effects.

The pairwise handoff is confirmed when an authenticated message is received at
the responder relationship DID. Until then, every package from that DID to the
contact carries the exact frozen `fromPrior` and uses the frozen long-form
sender spelling. An explicit ACK naming the receipt-required handoff response
controls delivery retry; a message merely addressed to the new DID confirms
rotation but does not invent an ACK.

A valid `peer.transitioned` changes current peer DID only inside its named
contact. It never globally retires or aliases the rendezvous DID.

### 14.6 Peer evidence and contact-scoped attribution

Build an evidence graph whose nodes are:

- authenticated channels with `peerKey != null`; and
- canonical peer DID strings.

The only global evidence edge is:

- `peer.resolved`: the exact channel to the canonical DID under which its
  authenticated peer key was found, together with the retained resolution
  snapshot.

A `peer.transitioned` edge is not global. It belongs only to its named contact
and must name the exact historical resolution evidence used to verify
`from_prior`. Likewise, `contact.peerDidAdded` is an outbound contact decision,
not global control evidence.

Exclude mediation channels from contact attribution.

For a channel, collect the distinct contact IDs from live `contact.attached`
edges reachable through its evidence graph:

- none: unattributed;
- one `cid`: attributed to it;
- several: multi-valued attribution conflict.

The fold never attributes an anonymous `peerKey == null` channel through the
graph.

Within one contact's relationship, apply valid `peer.transitioned` events as a
directed relationship graph. A transition replaces its predecessor only in
that relationship. Several unretired current ends are a visible relationship
conflict.

### 14.7 Contact fold

Fold each `cid` independently:

- deleted when that ID has a `contact.deleted` tombstone;
- `petname` is latest by canonical order;
- each flag is latest by canonical order;
- `claimedName` is latest `profile.nameClaimed` across attributed channels;
- `attached[]` is every live attach edge;
- `ourDids[]` is every non-retired DID named by `contact.useDid`;
- `peerDidSeeds[]` is every `contact.peerDidAdded` not named by a
  `contact.peerDidRemoved`;
- `theirDids[]` applies valid contact-scoped transitions to those seeds and
  peer DIDs evidenced by attached channels;
- `writeTo[]` is every non-conflicted relationship DID/channel for which an
  ordinary package can currently be prepared; and
- `thread` is the logical application-message union below.

A DID whose local role is `rendezvous` is never included in ordinary
`writeTo[]`, whether bootstrap is pending, rejected or not yet attempted. It
may be selected only by the explicit initial-message bootstrap procedure. This
prevents ordinary content from being sent to a rendezvous address.

A responder relationship may enter ordinary `writeTo[]` after effective
acceptance and pairwise DID creation. Until an authenticated message is
received at that pairwise DID, every prepared outbound package carries the
same byte-stable `from_prior`; implementations SHOULD prioritize the selected
handoff response to minimize reordering.

A fold MUST NOT select one of several current relationship ends by clock
order. Transition ambiguity, sender-DID disagreement and conflicting user
decisions are visible conflicts. A tombstoned deterministic rendezvous contact
is never recreated by another event with the same ID.

### 14.8 Inbound message and execution fold

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

Union authenticated MID groups into one logical message only when they have
the same wire ID, resolve to the same unique validated relationship scope,
have a verified scoped `peer.transitioned` chain between their sender
keys/DIDs, and agree on intent hashes with valid package evidence.
This is the only cross-peer-key wire-ID merge.

Resolve an execution scope before automatic handling. A final accepted
responder rendezvous candidate uses its deterministic relationship ID. A final
rejection may use only the fixed bootstrap control scope in `rendezvous.md`
section 13. An undecided candidate remains application-effect-deferred.
Initiator-side
handoff traffic uses a relationship scope only after a valid
`relationship.initiatorBound` reconstructs that same stable ID from the pinned
rendezvous evidence and the initiator's own relationship identity. Established
relationship traffic continues to use that ID across verified key rotations.
A permitted non-relationship channel uses its exact channel scope. An
unattributed, transition-pending or initiator-unbound observation is
effect-deferred.

Fold every `message.executionBound` whose scope, wire ID, derived execution ID
and referenced observations validate. A logical group has:

- no execution ID while no stable execution scope is available;
- one deterministic execution ID when all valid bindings resolve to the same
  scope and wire ID; or
- an execution-identity conflict when bindings claim different scopes or IDs.

A transition-verified alias inherits the relationship-derived execution ID and
is bound before handler execution. The runtime MUST NOT execute it under a
provisional peer-key/MID identity and merge it afterward. When execution
identity conflicts, previously recorded effects remain visible but no new
effect is emitted.

A conforming `https://didcomm.org/empty/1.0/empty` pure ACK is retained as a
control observation and its validated `ack` array is processed, but it is
excluded from thread display, unread counts, notifications and
application-content handlers.

A user-visible thread contains each remaining logical application message once,
positioned by the earliest canonical observation unless its application
protocol defines another display time.

### 14.9 Outbound message and delivery fold

Group `message.out` by `mid`. Multiple identical intent events are one logical
outbound. Different fields under one `mid` are a conflict, including local
control fields excluded from the intent hash.

ACK lookup uses `(carrier.logicalPeerScope, wireId)`. Before applying an ACK,
derive the candidate outbound's membership from non-conflicted portable
evidence as follows.

For relationship `R`, an outbound belongs to `R` when either:

1. a valid `relationship.initiatorBound` names its exact `initialMid` and
   `initialWireId`, or responder `relationship.established` names its exact
   local `handoffMid` and `handoffWireId`; or
2. its validated package sends from `R`'s local relationship DID to a DID/key
   in `R`'s verified peer chain, including only independently verified scoped
   continuations; its target is either the exact contact named by `R` or an
   explicit channel that exactly matches that package's channel. The local DID
   and authenticated peer-chain evidence identify that same unique `R`.

Responder `originInboundMid` and `originWireId` name received input, not a local
outbound. Wire-ID equality alone never establishes the first path. A subsequent
initial attempt may also belong to an already bound `R` when its pinned
rendezvous snapshot and local initiator key independently derive that same
relationship ID; the original binding is not rewritten to name the new attempt.

All valid packages of one outbound MUST be compatible with the same
relationship attribution. Retirement preserves historical scope evidence;
repacking through a verified continuation preserves scope and MUST NOT move
one logical outbound into a different relationship. Incompatible relationship
or package evidence is a scope conflict, not a latest-package selection.

For a permitted non-relationship channel `C`, membership requires the exact
`(myKey, peerKey)` tuple in the explicit target or validated package. If both
supply channel evidence, they MUST agree. Matching one key is insufficient.
A handoff carrier missing required relationship binding MUST NOT fall back to
a provisional channel scope. The no-handoff rejection defined in
`rendezvous.md` section 13 may instead acknowledge its pinned bootstrap channel;
that control-only ACK proves receipt, never relationship establishment or a
successful transition.

Exactly one compatible scope attribution for the requested processing path
must remain before applying the ACK. Missing evidence defers processing;
ambiguous or conflicting evidence suppresses it. Recovery may retry using the
original carrier after evidence arrives, with all original proof gates.

For a valid outbound:

- `packages[]` is every consistent `message.prepared` by `packageId`;
- all packages agree on `wireId` and `intentHash`;
- packages may differ in plaintext hash, sender/recipient DID, keys and
  `fromPrior` only under validated repack rules;
- one package is inactive for normal retry after `message.packageRetired` or a
  package-scoped non-retryable failure, but its exact envelope may remain held
  for duplicate replay;
- unresolved holds are exact `delivery.held` events not named by
  `delivery.released`;
- expand `message.out.pleaseAck` by replacing `""` with the outbound wire ID;
  `receiptRequired` is true exactly when the result contains that wire ID;
- `acknowledged` is true if a valid authenticated inbound `ack` names the wire
  ID on a validated peer-scoped continuation under the membership rules above,
  the carrier has its required execution binding, and all proof gates pass;
- `submitted` is true if any package has `delivery.submitted`;
- a message-scoped non-retryable failure, including expiry, permanently ends
  new automatic preparation/submission for that intent;
- for `receiptRequired == false`, the first successful submission also ends
  automatic background retry for the current message;
- a valid ACK arriving after expiry sets `acknowledged == true` and derives
  `late == true`, but does not reactivate work;
- `replayMaterialOpen` is true only when `replayUntil != null` and no valid
  `message.replayClosed` exists;
- `replaySubmissionEligible` additionally requires an unresolved hold to be
  absent, no message- or selected-package-scoped non-retryable failure, package
  expiry not to have passed, fold time to be before `replayUntil`, and an exact
  valid package to remain; and
- retryable failures remain diagnostic attempts.

Work eligibility and displayed outcome are separate. The displayed precedence
is:

```text
conflict
acknowledged (with late indicator when applicable)
held
expired-or-terminal-failure
submitted
prepared
queued
```

Expiry is an irreversible no-more-work boundary; later authenticated evidence
may improve display to acknowledged-late without restarting work.

The phase-1 active runtime processes every valid queued or retryable message.
Authorship never limits outbox ownership after an exact move or restore. When a
durable expiry has passed, no further preparation or submission is allowed.

### 14.10 Invitation fold

An OOB disclosure with `uses == "one"` is available for a new consumer only
when its DID is not retired and no valid final accept has consumed it.

A valid final accept consumes the locally disclosed invitation at the
acceptance commit when its candidate's immutable `pthid` names this `oobId`
and the candidate's local recipient DID matches the disclosure. The consumer
is the accept's deterministic relationship ID. A matching `pthid` alone,
a rejected candidate or following a remote invitation is not consumption.
`contact.attached` records channel attribution only; no later attachment or
relationship materialization is required to complete consumption.

The single writer checks availability and commits the winning acceptance in
one serialized finalization operation, before network work. A crash after that
commit leaves the invitation consumed even if no contact or pairwise DID has
yet been materialized. Recovery may finish that relationship's missing facts,
but does not perform another consumption step.

Detach, contact deletion, content erasure and clock rollback do not reopen an
invitation or remove its original consumer. Further initial messages for the
same accepted relationship may reuse it without creating a second consumer.
Incompatible accepted consumers or conflicted acceptance evidence keep the
invitation unavailable and surface a conflict. No consumption or unconsumption
event is needed.

A `uses == "many"` rendezvous disclosure remains open while its DID is live
and its rendezvous policy admits initial messages. It does not disclose a
relationship DID.

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

The application computes the roots passed to `ObjectStore.collect` under the
GC coordination contract in `event-store.md` and `dasl-objects.md`.

A root is held when at least one accepted event retains it through
`event.roots`, except that a root named by `message.erased` is no longer held
by that message.

This section is the sole normative owner of prepared-envelope retention.
For a consistent outbound `M` and valid package `P`, define:

```text
normalComplete(M) =
    acknowledged(M)
    or (!receiptRequired(M) and submitted(M))

normalMaterialNeeded(M, P) =
    !retired(P)
    and !packageTerminalFailure(P)
    and !messageTerminalFailure(M)
    and !normalComplete(M)

replayMaterialOpen(M) =
    M.replayUntil != null
    and no valid message.replayClosed exists for M

retainEnvelopeForMessage(M, P) =
    !erased(M, P.envelope)
    and (normalMaterialNeeded(M, P) or replayMaterialOpen(M))
```

Terminal failure means valid committed non-retryable `delivery.failed` at the
specified scope; a committed expired failure is message-terminal. Sampling wall
time beyond expiry blocks work but MUST NOT release normal-only material until
that durable termination is committed. A valid ACK completes normal delivery
even when an outcome-unknown transport attempt has no `delivery.submitted`.

Holds, unavailable routes, retryable resolution failures and other reversible
scheduling conditions MUST NOT make `normalMaterialNeeded` false. They block
submission, not retention. A null `replayUntil` creates no replay obligation
and requires no closure event: retirement or permanent normal completion may
release that package's contribution immediately under the normal GC rules.

For non-null `replayUntil`, every valid prepared package retains its replay
contribution until closure. Retirement, completion, hold and ordinary terminal
delivery failure do not close it. Reaching the replay deadline blocks replay
submission immediately, but release waits for committed `message.replayClosed`.
Explicit erasure overrides this message/root contribution and requires the
existing erased-closure recovery procedure. Closed replay never reopens after
restart, deletion of `local/`, clock rollback or duplicate receipt.

`erased(M, root)` names the permanent message/root relation, not global deletion
of a CID. Another independent non-erased reference may retain the same bytes.
Conflicted evidence is not release authority: disputed package roots remain
held until unambiguous release evidence or explicit erasure exists.

Normal and replay submission eligibility additionally check current time,
holds, addressing, proof, route and available bytes. Neither scheduling
predicate is a retention predicate. Removing one contribution does not authorize
collection while another event or an in-flight reference/snapshot guard retains
the object.

Unknown event types retain every exact root in their `roots` because version 3
defines no erase rule for them. A CID embedded in object content is not a
retention edge unless it also appears in an accepted event's `roots`.

An object may be collected only when its exact CID is absent from the current
held-root set, is absent from pending-reference guards, and the backend's
orphan grace has elapsed. A stale held-root snapshot never authorizes unlink
after a new event reference commits.

### 15.4 No runtime-local eviction event

Version 3 does not represent local body eviction as a portable event. A local
storage policy that deletes a non-erased retained object makes the phase-1
vault incomplete. It may be repaired from a verified folder import or backup.
Deferred `vault-sync/1.0` may later provide another repair source. Local
absence never authorizes collection elsewhere.

## 16. Procedures

These procedures define required ordering. Implementations may combine steps
transactionally but may not reverse the durability boundaries.

### 16.1 Open the writable full runtime

1. verify folder/store version and anchor;
2. unlock or obtain the seed;
3. acquire the exclusive writer lock before creating mutable local state;
4. complete backend recovery and any import publication barrier, then load or
   mint local `replica_id` and `store_generation`;
5. fold portable state and reconstruct committed held roots, and only then
   release abandoned guards and permit GC;
6. project receipt-integrity conflicts and recover the vault-wide ordinal
   high-water mark under section 10.2 before accepting a new inbound
   observation; cross-author ordinal reuse does not block open or import;
7. enumerate committed inbound observations with unfinished admission,
   transition/binding, ACK or protocol-defined deterministic effect work;
8. idempotently reconcile those observations, relationship materialization,
   pending candidate erasures and replay closure from portable history;
9. derive every required mediation account; and
10. independently start recipient reconciliation, account-scoped pickup, live
    delivery and eligible outbox work.

Recovery in steps 7–8 MUST NOT depend on mediator redelivery or a surviving
local queue. It reuses frozen ACK arrays, output intents and execution IDs;
it does not invent missing evidence or re-run an optional decision merely
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

### 16.4 Create a relationship DID

This procedure is used by an initiator before rendezvous and by protocols that
create ordinary pairwise relationships.

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
relationship DID MUST use the long form; subsequent messages and mediator
registration use the short form.

Changing keys or bound route creates a new relationship DID and a
contact-scoped transition. The existing DID entity is not edited.

### 16.5 Configure and disclose a rendezvous DID

The Peer profile requires no domain or network resolver:

1. create or choose one reusable route, usually mediated;
2. mint a UUIDv7 DID entity ID and derive its authentication and key-agreement
   keys;
3. build and validate a `did:peer:4` long form whose input document embeds
   those keys and exactly that bound route;
4. append `did.created` with both Peer spellings and the bound route, plus
   `rendezvous.generationConfigured` referencing that DID and freezing the
   relationship route, `initialMessageTypes`, admission policy and limits;
5. when the bound route is mediated, reconcile and verify registration of the
   canonical short form; and
6. append `did.disclosed`, exposing only the rendezvous Peer DID long form in
   an OOB invitation, QR, file or another discovery object.

The rendezvous generation is live after local long-form validation and current
bound-route reconciliation. If the active runtime temporarily cannot map the
recipient key, it leaves the mediator delivery unacknowledged until local state
is repaired and refolded. The rendezvous DID belongs to the vault, not the
process displaying the invitation.

### 16.6 Send an initial message

See `rendezvous.md` section 8.5.

### 16.7 Admit and establish a relationship

See `rendezvous.md` section 10.2.

### 16.8 Send an ordinary message

See `distributed-delivery.md` section 4.2.

### 16.9 Receive a message

See `distributed-delivery.md` section 9.1.

### 16.11 Close duplicate replay

For every outbound whose `replayUntil` is non-null:

1. if replay is already closed, do nothing;
2. if explicit erasure applies, append
   `message.replayClosed(because="erased")`;
3. otherwise, when the runtime observes `now >= replayUntil`, append
   `message.replayClosed(because="deadline")`;
4. refold held roots only after that event is process-durable; and
5. permit GC to release exact replay-only envelope objects only after the
   closure is visible to the held-root fold.

Clock rollback after step 3 does not reopen replay.

### 16.12 Erase a message

1. fold every root currently retained by the logical message and its prepared
   packages;
2. if `replayUntil` is non-null, replay is still open, and the erase covers
   its exact replay roots, include `message.replayClosed(because="erased")`;
3. process-durably append the erase event(s) and any replay closure, preferably
   in one `appendAll`;
4. refold held roots; and
5. call object collection.

Late duplicate observations may introduce another event retaining the same
logical roots. The active runtime that observes an existing erase MUST append
an equivalent erase for newly learned roots of that message before those roots
are considered intentionally released. A future replicated profile applies the
same closure rule in every full copy.

### 16.13 Delete a contact

1. append `contact.deleted` for the exact `cid`;
2. for every message exactly attributed to that contact, append erases for
   body, attachment and prepared-envelope roots required by policy;
3. retire relationship DIDs exclusively associated with that contact;
4. unregister their mediated bound-route pairs, retiring a reusable route only
   when no other live DID requires it;
5. preserve a shared rendezvous DID unless separately retired; and
6. collect unheld objects after grace.

A late message attributed to that tombstoned contact requires the same
idempotent cleanup procedure.

## 17. Merge, synchronization and restore

### 17.1 Event merge

Merge is event-store union by `eid`. It never:

- rewrites an event;
- removes another replica's decision;
- treats another author as read-only history;
- creates `delivery.held` because of authorship; or
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
Before accepting new inbound observations it recovers the receipt-ordinal
high-water mark across all historical authors. It also reconciles unfinished
committed inbound work under section 16.1, including observations already
pickup-ACKed before the snapshot. Local queue state is not a recovery source.

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
6. `pleaseAck` containing `""` or the current wire ID makes that message
   receipt-required; an array naming only older IDs does not.
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
14. Expiry irreversibly ends work; later valid evidence may display
    acknowledged-late without restarting it.
15. Equal authenticated variants derive one observation MID. Equal wire IDs
    under transition-verified peer keys in one relationship merge only at the
    logical-message layer.
16. Before the first automatic effect, `message.executionBound` derives its
    execution ID from the stable relationship-or-channel scope and wire ID, not
    from an observation MID or contact ID.
17. A transition-pending observation is effect-deferred; once verified, a
    cross-key alias in the same relationship derives the same execution ID.
18. A wrong derived ID or different scope preserves prior history but suppresses
    new automatic execution as an execution-identity conflict.
19. Intent conflicts suppress disputed automatic effects and ACK
    processing.
20. Pure Empty ACK is retained and processed but excluded from threads,
    unread counts, notifications and application handlers.
21. Pure ACK has `pleaseAck == null`; its first successful submission is
    terminal and creates no ACK loop.
22. Duplicate receipt of a message whose requested IDs were already honored
    re-submits the same prepared response/ACK package.
23. Account-scoped Pickup ACK follows durable message/object commit for
    admitted traffic.
24. Unlock/recovery-incomplete input and an exact known local key-agreement
    method with a recoverable missing prerequisite remain unacknowledged;
    after key state is authoritative, foreign DIDs, nonexistent/wrong-purpose
    local fragments and terminal rendezvous generations are terminal
    wrong-recipient input and do not remain pending.
25. Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.
26. `peer.resolved` retains exact canonical document bytes under their raw CID,
    presented/canonical DID forms and selected key IDs, including for external
    `did:web` peers.
27. Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
28. A reusable invitation contains a rendezvous DID and no relationship DID;
    the local Peer path requires no DNS or Web DID.
29. Every implementation hard-gate accepts valid initial plaintext up to
    65536 bytes and positive lifetime up to 604800 seconds, subject only to
    emergency resource and abuse limits.
30. Trust Ping `ping` is always supported; protocol preference and missing
    current-message receipt request are post-admission policy, not silent
    hard-gate rejection.
31. The first bootstrap message is an ordinary application message, not an
    Estoc rendezvous wrapper.
32. `relationship.admissionDecided` records one final accept/reject result.
    Different `because` or `code` provenance leaves otherwise equal results
    equivalent; different decisions, relationship IDs or candidate evidence
    conflict and suppress new effects.
33. Two initial wire IDs from the same `(rendezvous DID, initiator key)` derive
    one relationship/contact/responder DID and remain separate messages.
34. A deterministic contact tombstone is not resurrected; reconnect requires a
    fresh initiator relationship key.
35. Event `at` is parsed as RFC 3339 and compared with Epoch-Seconds expiry as
    an instant; equality is expired.
36. A final accept remains final before handoff materialization and after
    restart or later expiry. The writer refuses contradictory finalization;
    ending the relationship uses contact deletion, not a reject note.
37. Stable `relationship.established` freezes origin, exact prior form/kid,
    responder long form, relationship-level rotation `iat`, `fromPrior` and
    handoff IDs.
38. `from_prior.iss` uses the exact invitation/snapshot form and its protected
    `kid` belongs to that exact DID.
39. `from_prior.sub` equals plaintext `from` byte-for-byte; before confirmation
    both use responder Peer-DID long form.
40. The initiator validates `iat` against one of its retained initial-message
    `createdTime` values and verifies the corresponding pinned snapshot before
    applying ACK or transition.
41. Response intent precedes pairwise recipient registration, and registration
    precedes submission.
42. Trust Ping is the default no-content initial message; an application
    message may be first without wrapping.
43. A handoff response is deterministic, explicitly ACKs the trigger, requests
    its own ACK with `pleaseAck == [""]`, and carries frozen `fromPrior`.
44. Human-authored content is ordinary later traffic and does not choose the
    relationship origin or rotation time.
45. Until an authenticated message arrives at responder pairwise DID, every
    package from it carries the same `fromPrior` and uses long-form sender
    spelling.
46. A rejected durable candidate eventually releases its content roots through
    `message.erased`; the skeleton remains, including for silent rejection.
47. A rendezvous DID is excluded from ordinary `writeTo`; the initial-message
    procedure is the only ordinary sender path targeting it.
48. Contact-scoped transition does not globally retire or union the rendezvous
    DID with unrelated relationships.
49. Peer rendezvous and relationship DIDs may use different mediation routes.
50. The desired recipient pair is derived only from a live DID's bound route.
    Registration is queried and reconciled on reconnect and after restore;
    local trace loss does not change that desired set.
51. Each local DID entity derives one fixed authentication key and one fixed
    key-agreement key by name from its entity ID and has one immutable bound
    route. Key or route rotation creates a new entity; both validated Peer
    spellings map to the same entity. A rendezvous generation references that
    entity and stores only its admission/handoff policy.
52. Erasure is checked before object presence; late roots receive equivalent
    erasure closure.
53. Restore from a readable folder creates a new local author unless it is an
    exact move, reconciles standard mediation/pickup and resumes eligible
    outbox work.
54. Phase 1 requires neither `replica-mediation/1.0` nor `vault-sync/1.0`.
55. Shuffling the same event set leaves every phase-1 fold result unchanged.
56. Closed attachment normalization makes intent hashes independent of
    implementation-selected presentation or diagnostic metadata.
57. A deterministic response remains replayable from its exact prepared
    envelope after acknowledgment until replay is process-durably closed; merely
    reaching `replayUntil` does not authorize collection before
    `message.replayClosed`. Explicit erasure may close it early without minting
    a replacement package.
58. The held-root fold and pending-reference guards prevent GC from unlinking
    an object before or after the event that references it commits.
59. A successfully appended inbound event survives immediate process restart
    before the mediator pickup acknowledgment is sent.
60. ACK-target lookup is scoped by the carrier's stable relationship/channel
    execution scope plus requested wire ID; another peer or relationship using
    the same wire ID is never acknowledged.
61. Every accepted inbound carries a durable phase-1 receipt ordinal. ACK arrays
    use `firstReceiptKey`; clock rollback does not reverse receipt order in a
    linear history, and cross-author ties have deterministic recovery order.
62. The initiator commits `relationship.initiatorBound` and a
    `message.executionBound` before the handoff-confirmation effect; restart
    immediately afterward reconstructs the same relationship execution ID.
63. Later transition-verified aliases/rotations in that relationship reuse the
    same execution ID and cannot execute the same logical wire message twice.
64. `message.replayClosed` is committed before replay-only roots are released;
    restart, loss of `local/` and clock rollback do not reopen closed replay.
65. Hold and ordinary terminal delivery failure block replay submission without
    releasing still-open replay material; release resumes only while every
    remaining replay condition is valid.
66. The inbound MID vectors in `distributed-delivery.md` section 9 recompute to
    `29370ccd-932b-51eb-9cc3-4c083adc151a` and
    `206bcd7e-7320-5512-bbdb-a4d19331d58e` from their published inputs.
67. Attachment IDs obey DIDComm 2.1 URI-unreserved syntax independently of
    filename or DASL object identity.
68. A normal-only package survives hold, GC and release with its exact bytes;
    route unavailability also does not release normal retry material.
69. Retiring a normal-only package permits release without an invalid null-
    deadline closure; replay-enabled packages remain held until valid closure.
70. Shared envelope bytes remain held by another non-erased message even after
    one message/root relation is erased.
71. Each new duplicate observation receives a fresh ordinal; exact re-ingest
    does not. The logical group's minimum complete `(integer ordinal, author)`
    key orders future ACKs without changing any already frozen ACK array.
72. Restore, restart and loss of `local/` recover the ordinal high-water mark
    across all historical authors. Cross-author equal ordinals survive import
    and sort by author on a tie; allocation resumes above the union's maximum.
73. A final accept consumes a matching local one-use invitation before any
    attachment or relationship materialization. Crash, detach, contact deletion,
    erasure and clock rollback do not reopen it; same-consumer reuse is not a
    second consumption, and another consumer is rejected.
74. Responder origin inbound IDs never identify a local outbound by coincidence;
    local handoff and initiator initial outbounds use their exact named MIDs.
75. An ACK-only carrier can bind with `because == "ack"` without executing a
    handler. Different descriptive binding reasons do not change identity.
76. A known responder DID with incomplete handoff binding remains deferred;
    recovery completes missing facts atomically before ACK or effect processing.
77. A pickup-ACKed inbound with unfinished deterministic work is rediscovered
    from portable history on open, without redelivery or a surviving local queue.
78. Final reject followed by erasure cannot be turned into accept for the same
    candidate. Incompatible imported final results suppress new effects.
79. A no-handoff problem report may acknowledge only its validated bootstrap
    channel; it never establishes a relationship or bypasses handoff proof.
80. Final rejection and any selected response intent/binding commit atomically.
    Recovery resumes only committed response work and erasure, never an
    uncommitted optional response or a replacement admission outcome.
81. Distinct events sharing a receipt `(author, ordinal)` pair remain history
    with a projected receipt-integrity conflict, not a full-import failure.
    Only affected logical messages are excluded from newly frozen ACK targets.
82. Every permutation of a fixed event union yields the same minimum complete
    receipt key and scope-local order. Learning an older verified alias may
    change future order, never a previously frozen ACK array.
83. Equivalent final admission events have one effective result; undecided or
    conflicted candidates have none, even if a final accept event is present.
84. A new consumer of an unavailable one-use invitation gets final reject;
    same-consumer reuse and recovery do not reject or overwrite an existing
    accepted result. Conflicting accepted consumers keep it unavailable.
85. Adding `contact.merged` changes only display grouping. Per-`cid` decisions,
    relationship scopes, message/execution IDs, ACK results, invitation state
    and deletion/erasure behavior remain unchanged.
86. A matching `pthid` without a valid accept for the disclosed local recipient
    DID does not consume an invitation. `contact.attached` alone does not
    consume it, including when following a remote invitation.
