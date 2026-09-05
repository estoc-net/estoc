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
the DID before using the vault. The anchor remains independent of rendezvous and relationship communication
DIDs. In particular, neither a default Peer rendezvous DID nor an optional
`did:web` facade replaces the anchor merely because it is disclosed publicly
or served by a web-hosted full replica.

### 3.2 Single seed

One seed derives every vault-controlled asymmetric key. The current key
profile uses HKDF-SHA-256 with the `@estoc/keystore` v3 domain separation.
The same seed and same key name always produce the same key material.

Reserved names are:

| name | purpose |
| --- | --- |
| `anchor` | immutable vault identity anchor |
| `mediation/<id>/me` | DIDComm identity for one mediation arrangement |
| `did/<id>/authentication/<generation>` | signing/authentication key for one communication DID generation |
| `did/<id>/key-agreement/<generation>` | DIDComm key-agreement key for one communication DID generation |
| `sync/account` | shared authenticated account used by `vault-sync/1.0` |

`<id>` is the DID entity ID. `<generation>` is a base-10 non-negative integer
without leading zeroes except `0`. Version 3 defines exactly one
authentication key and one key-agreement key in each generation; the event
arrays reserve compatible growth without changing key-name syntax. Key names
are never renamed or reused. They do not encode a contact, replica, domain
owner or process location.

A version-3 `did:peer:4` rendezvous or relationship DID has generation `0`;
changing its keys or embedded service creates another DID and an explicit
scoped transition. An optional `did:web` rendezvous DID may add later key
generations while its DID string remains unchanged.

TLS private keys, DNS credentials, ACME account keys and web deployment
credentials are not vault communication keys and MUST NOT be derived from
these names.

The fixed symmetric sync keys are derived as specified by
`vault-sync/1.0`; they are not represented as event entities.

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
    "myKey": "did/019b2a45-8381-793f-943c-f5d806fd5ca2/key-agreement/0",
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
that happens to publish a web document.

A communication DID has one of two roles in version 3:

```text
rendezvous    bootstrap discovery; default did:peer:4, optional did:web facade
relationship  pairwise ongoing communication; did:peer:4
```

The role is application meaning. Delivery routes are reusable vault-scoped
transport configurations selected by DIDs. The mediator is method- and
role-neutral.

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

### 5.2 DID identity and key generations

#### `did.created`

The default rendezvous form is a Peer DID:

```json
{
  "type": "did.created",
  "roots": [],
  "data": {
    "id": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "did": "did:peer:4zQm...rendezvous-short",
    "longForm": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "method": "peer",
    "role": "rendezvous",
    "generation": 0,
    "authenticationKeys": [
      "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/authentication/0"
    ],
    "keyAgreementKeys": [
      "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0"
    ],
    "boundRoute": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
  }
}
```

`method` is `peer` or `web`; `role` is `rendezvous` or `relationship`.
Version 3 permits:

```text
(peer, rendezvous)      default local-first discovery
(peer, relationship)    pairwise ongoing relationship
(web, rendezvous)       optional public Web facade
```

Generation `0` is created with the DID. `authenticationKeys` and
`keyAgreementKeys` each contain exactly one version-3 key name under the DID
entity ID and generation.

For every `did:peer:4`, whether rendezvous or relationship:

- `did` is the canonical short form;
- `longForm` is the validated self-resolving long form;
- `boundRoute` is REQUIRED and equals the route encoded in the input document;
- seed-derived public keys and route MUST match that document; and
- changing keys or route creates another DID entity and an explicit scoped
  transition.

The long form is disclosed before the short form is relied upon by a peer.
The short form is canonical for vault references and mediator recipient
registration after the mapping is known.

An optional Web rendezvous variant is:

```jsonc
{
  "id": "019b2a55-22b4-7fd3-9c77-70cd01fb3fb6",
  "did": "did:web:alice.example",
  "longForm": null,
  "method": "web",
  "role": "rendezvous",
  "generation": 0,
  "authenticationKeys": ["did/019b2a55-22b4-7fd3-9c77-70cd01fb3fb6/authentication/0"],
  "keyAgreementKeys": ["did/019b2a55-22b4-7fd3-9c77-70cd01fb3fb6/key-agreement/0"],
  "boundRoute": null
}
```

Its selected DID document, rather than the DID string, binds keys and routes.
A deterministic rendezvous handler may use a UUIDv5 entity ID; ordinary
creation uses UUIDv7. Same ID with different identity fields is an integrity
conflict.

#### `did.keyGenerationAdded`

```json
{
  "type": "did.keyGenerationAdded",
  "roots": [],
  "data": {
    "did": "019b2a55-22b4-7fd3-9c77-70cd01fb3fb6",
    "generation": 1,
    "authenticationKeys": [
      "did/019b2a55-22b4-7fd3-9c77-70cd01fb3fb6/authentication/1"
    ],
    "keyAgreementKeys": [
      "did/019b2a55-22b4-7fd3-9c77-70cd01fb3fb6/key-agreement/1"
    ]
  }
}
```

Only a non-retired Web rendezvous DID may add generations in version 3. Peer
DIDs rotate by creating another DID. A generation number and every key name
are immutable; conflicts are surfaced rather than selected by arrival order.

#### `did.keyGenerationSelected`

```json
{
  "type": "did.keyGenerationSelected",
  "roots": [],
  "data": {
    "did": "019b2a55-22b4-7fd3-9c77-70cd01fb3fb6",
    "generation": 1
  }
}
```

The latest valid selection by canonical event order is preferred for new Web
rendezvous cryptographic use and document preparation. Generation `0` is the
default. Selection does not delete private keys or invalidate historical
initial-message-bound evidence.

### 5.3 Delivery routes

A route is a reusable, vault-scoped transport configuration. It does not
belong to a replica or a single communication DID. One rendezvous DID and many
pairwise DIDs may select the same route, which is how they reuse a mediator
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
MUST NOT identify one replica as the DIDComm application recipient. The
route itself neither publishes a DID document nor registers a recipient.

Equal configurations under one route ID are semantic duplicates. Different
values under one ID are an integrity conflict. A transport endpoint or
mediation change normally creates a new route ID, allowing old and new routes
to overlap during cutover.

#### `did.routesSelected`

```json
{
  "type": "did.routesSelected",
  "roots": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "routes": ["019b2a58-fef5-7d59-ae1c-46e4f0a13c73"]
  }
}
```

The latest valid event by canonical order selects an ordered, non-empty list
of configured, non-retired routes for the DID. It MUST NOT contain duplicate
route IDs or two mediated routes backed by the same mediation arrangement.
Order expresses publication or sending preference, not application fan-out.
A sender normally delivers one package through one route and tries another
only after failure.

For every `did:peer:4`, whether its role is `rendezvous` or `relationship`,
the list MUST contain exactly its `boundRoute`; changing that route creates a
new Peer DID entity and the applicable disclosure or contact-scoped
transition. An optional rendezvous `did:web` may publish several routes while
its DID string remains unchanged.

#### `did.routeRegistered`

```json
{
  "type": "did.routeRegistered",
  "roots": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "route": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "registrationId": "019b2a55-bae7-705a-baea-45782de39809"
  }
}
```

This is an observation that the mediator behind the named route accepted
recipient registration for the named DID string. Phase 1 uses ordinary
Coordinate Mediation. A deferred mediator extension may later strengthen
recipient-control proof without changing this event shape.

It is not permanent proof of current mediator state. Every connection
queries and reconciles the desired `(DID, route)` set from the converged
vault fold.

#### `did.routeUnregistered`

```json
{
  "type": "did.routeUnregistered",
  "roots": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "route": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "registrationId": "019b2a55-bae7-705a-baea-45782de39809"
  }
}
```

This observes successful removal of that exact registration generation for
the `(DID, route)` pair. A delayed removal for an old `registrationId` does
not cancel a later registration. Direct routes never produce registration
events.

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

Retirement is terminal for the reusable route ID. Every DID that still
selects or binds it becomes visibly unroutable until another valid route is
selected or a successor DID is created. Retirement does not erase retained
messages or historical per-DID registration observations.

### 5.4 Disclosure and web document publication

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

This is the permanent record that a DID was revealed for a purpose. It is
not the publication of a `did:web` document.

Before disclosure, every selected mediated route MUST have a currently
verified recipient registration. A reusable invitation SHOULD expose a
rendezvous DID and MUST NOT expose a relationship DID. The default Peer
profile discloses the validated `did:peer:4` long form; the optional Web
profile discloses its `did:web` value.

#### `did.documentPrepared`

```json
{
  "type": "did.documentPrepared",
  "roots": ["bafkrei...did-document"],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "revision": "019b2a5b-5ab4-7c15-8b86-50650b78558d",
    "previous": null,
    "document": "bafkrei...did-document",
    "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos",
    "keyGenerations": [0],
    "routes": ["019b2a58-fef5-7d59-ae1c-46e4f0a13c73"]
  }
}
```

This materialization stores exact RFC 8785 canonical UTF-8 JSON for one
`did:web` document revision. The document's `id`, verification methods,
relationships and DIDComm services MUST match the named DID, key generations
and routes. `documentHash` is unpadded base64url SHA-256 of the object bytes.

`previous` is the selected predecessor revision or null for the first
revision. Conflicting data under one revision ID is an integrity conflict.

#### `did.documentSelected`

```json
{
  "type": "did.documentSelected",
  "roots": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "revision": "019b2a5b-5ab4-7c15-8b86-50650b78558d"
  }
}
```

The latest valid selection by canonical order is the desired public
revision. Selection does not prove that the remote HTTPS resource changed.

A selected revision may retain verification methods from several key
generations during a graceful rollover, but a version-3 rendezvous profile
selects exactly one key-agreement generation for new initial messages. Older
authentication methods may remain authorized for delayed `from_prior`
verification. Every mediated route in the selected document must be
registered before the revision is advertised as successfully published.

#### `did.documentPublished`

```json
{
  "type": "did.documentPublished",
  "roots": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "revision": "019b2a5b-5ab4-7c15-8b86-50650b78558d",
    "url": "https://alice.example/.well-known/did.json",
    "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos",
    "etag": "\"abc123\""
  }
}
```

This is an observation that an HTTPS read after publication returned the
selected DID document bytes and matching DID `id`. `etag` is null when the
server did not provide one.

The observation is not permanent authority over remote state. A publishing
runtime re-fetches and compares the selected revision on startup and after
remote conflicts. `did:web` defines the document location but not Estoc's
management API or authentication mechanism.

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

Retirement is terminal for the DID entity. Its mediated routes are removed
from the desired recipient set, it is not chosen for new outbound messages,
and a web publisher no longer treats a selected revision as desired.

An envelope that still arrives for a retired key may be durably recorded
before policy rejects further interaction; retirement is not retroactive
erasure. Historical events, key derivation and contact-scoped transition
evidence remain.

## 6. Identity metadata, deferred replica/sync state and extensions

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

### 6.2 `replica.label` (deferred)

This event is reserved for the deferred multi-replica profile and is not
required by phase 1.

```json
{
  "type": "replica.label",
  "roots": [],
  "data": {
    "replica": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
    "name": "Phone"
  }
}
```

A label is encrypted vault metadata used to join a mediator's opaque
replica list with a human-readable UI. The latest label per replica by
canonical order wins. It is never sent to the mediator.

### 6.3 `replica.retired` (deferred)

This event is reserved for the deferred multi-replica delivery profile. Phase
1 does not register replica IDs with a mediator and does not use this event in
normal operation.

```json
{
  "type": "replica.retired",
  "roots": [],
  "data": {
    "replica": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
    "because": "inactivity-policy"
  }
}
```

`because` is REQUIRED and is one of:

```text
user
replaced
lost
inactivity-policy
fork-recovery
other
```

Retirement is a terminal desired-delivery policy for that replica ID:

- active replicas reconcile it to every shared mediation account;
- a mediator stops creating future deliveries for the retired ID;
- events already authored by it remain valid and synchronizable; and
- it does not revoke the seed or prevent a holder from registering a fresh
  replica ID.

A local runtime that learns from a converged event set **or an authenticated
mediator response** that its current ID is terminally retired MUST perform the
local re-incarnation procedure in section 16.10 before any further append,
pickup acknowledgment, live-delivery registration or outbound submission.
The old author is not rewritten and pending old-author events remain valid.

### 6.4 Sync-store events (deferred)

The following events are reserved for `vault-sync/1.0`, which is not a phase-1
implementation requirement.

#### `sync.configured`

```json
{
  "type": "sync.configured",
  "roots": [],
  "data": {
    "id": "019b2a5d-4cd0-7d87-a464-f0614c310870",
    "storeDid": "did:web:sync.example"
  }
}
```

This intent adds one `vault-sync/1.0` service locator to portable vault
state. `id` is a UUIDv7. `storeDid` MUST identify a DIDComm-capable sync
store; its current endpoint is resolved at runtime and may be cached only
under `local/`.

The same configuration ID with a different store DID is an integrity
conflict. Configuring the same store DID under more than one ID is
allowed but SHOULD be surfaced as redundant configuration.

#### `sync.selected`

```json
{
  "type": "sync.selected",
  "roots": [],
  "data": {
    "id": "019b2a5d-4cd0-7d87-a464-f0614c310870"
  }
}
```

The latest event by canonical order selects the preferred sync store for
normal publication and bootstrap guidance. Selection does not remove
another configured store; a runtime MAY mirror to every usable store.

#### `sync.retired`

```json
{
  "type": "sync.retired",
  "roots": [],
  "data": {
    "id": "019b2a5d-4cd0-7d87-a464-f0614c310870",
    "because": "replaced"
  }
}
```

Retirement is terminal for the configuration ID. Replicas stop new
upload, download and inventory work against it after learning the event.
Remote ciphertext deletion, if a deployment offers an administrative
account-reset operation, is outside `vault-sync/1.0` and is not implied by
retirement.

A readable folder therefore carries its sync-service locator in events.
A bootstrap that starts with only the seed still needs one locator from an
external trusted source to find the first sync store.

### 6.5 Extension lifecycle

```json
{
  "type": "extension.installed",
  "roots": [],
  "data": {
    "ext": "019b2a60-4f62-77af-b253-cb58278ade55",
    "name": "onion",
    "object": "bafkrei..."
  }
}
```

```json
{
  "type": "extension.removed",
  "roots": [],
  "data": {
    "ext": "019b2a60-4f62-77af-b253-cb58278ade55"
  }
}
```

```json
{
  "type": "extension.purged",
  "roots": [],
  "data": {
    "ext": "019b2a60-4f62-77af-b253-cb58278ade55"
  }
}
```

`installed` mints the extension-store ID. `object` is an optional name or
signed-package root understood by the host; it is not a object reference
and therefore is absent from event `roots`.

`removed` stops ordinary execution but preserves the extension store.
`purged` is terminal and requires the active runtime to dispose the extension
store and extension-local state. A future replicated runtime applies the same
rule in every full copy. The lifecycle events remain in the main
vault event set.

Version 3 treats extensions as host-shipped code. Portable third-party
code distribution is outside this document.

## 7. Contacts

A contact is a set of decisions identified by `cid` and connected through
`contact.merged` edges. It may hold an unverified rendezvous DID before any
authenticated channel exists and later move to a pairwise DID within the same
relationship context.

### 7.1 Contact IDs

A user-created contact uses a UUIDv7 `cid`.

An automatic handler adopting an ordinary authenticated channel uses:

```text
cid = UUIDv5(
  bc4ed155-49e2-58d4-93da-a4ec78ff2f58,
  RFC8785(["v1", myKey, peerKey])
)
```

A responder admitting an initial message at a rendezvous DID instead uses:

```text
cid = UUIDv5(
  dec849c7-4961-5f33-94e7-702684d5a95c,
  RFC8785(["v1", relationship_id])
)
```

`relationship_id` is the deterministic value defined by the rendezvous
processing profile over the exact rendezvous DID and authenticated initiator
key. It deliberately excludes the initial-message wire ID. Retries and later
initial messages from the same initiator key therefore reuse one contact; each
initial message still has its own protocol thread and response effect. A live `contact.deleted` tombstone for this deterministic ID prevents
automatic recreation.

`peerKey == null` MUST NOT be automatically adopted without an
application-specific authenticated discriminator.

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
deterministic `effectId` when the schema-producing procedure has one. For a stable rendezvous contact, an initial-message-specific protocol effect
ID MUST NOT be copied here: later initial messages share the contact. Such an
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

Latest by canonical order wins across the merged contact component.

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

Latest per `(contact component, flag)` wins.

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
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "because": "rendezvous",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb"
  }
}
```

`because` is `invitation`, `rendezvous`, `accepted`, `automatic` or
`manual`. `oobId` is nullable and is non-null when the attachment consumed or
followed a particular invitation.

This is the explicit decision that an authenticated channel belongs to a
contact. It is not inferred from a DID claim alone.

#### `contact.detached`

```json
{
  "type": "contact.detached",
  "roots": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
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

This is an undirected contact edge. The fold takes connected components of
all merge edges. Direction is descriptive only. Cycles and concurrent
opposite-direction merges are harmless.

There is no unmerge in version 3. Recovery for a mistaken merge is to detach
channels and create or attach the desired contact.

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

This is a permanent tombstone for one contact ID. Deleting a merged contact
appends one tombstone for every currently known member of the component. A
member learned later requires another tombstone.

## 8. Stored message document and message hashes

Message application content is kept in whole-resource raw DASL objects. The
body root of `message.out` and `message.in` names RFC 8785 canonical UTF-8 JSON with this
shape:

```json
{
  "body": {
    "text": "hello"
  },
  "attachments": [
    {
      "id": "a1",
      "media_type": "image/png",
      "filename": "photo.png",
      "root": "bafkrei..."
    }
  ]
}
```

Rules:

- `body` is the DIDComm application body object;
- `attachments` is ordered as in the logical application message;
- each descriptor's `root` is also listed in the event's
  `data.attachments` and envelope `roots`;
- optional DIDComm attachment metadata may be retained as additional
  documented fields;
- attachment bytes are separate whole-resource raw DASL objects;
- inline `data.base64` attachments are decoded before storage;
- inline `data.json` attachments are stored as UTF-8 RFC 8785 canonical JSON
  in a raw DASL object; and
- external links are not fetched merely because a message names them.

Version 3 uses three different hashes. They MUST NOT be conflated.

### 8.1 Semantic hash

The semantic projection contains only:

```json
{
  "id": "<wire ID>",
  "type": "<message type>",
  "thid": null,
  "pthid": null,
  "body": {},
  "attachments": []
}
```

`body` and `attachments` are reconstructed from the stored message document.
Absent thread values are represented as null. `semanticHash` is unpadded
base64url SHA-256 of RFC 8785 canonical UTF-8 JSON for this projection.

It excludes package addressing and control headers:

```text
typ, from, to, created_time, expires_time,
please_ack, ack, from_prior
```

`return_route` is forbidden in an Estoc vault application plaintext. It is a
transport-local hint and is neither a semantic nor a package variation.

### 8.2 Intent hash

The intent projection contains the semantic projection plus immutable
message-level control headers:

```json
{
  "semantic": {
    "id": "<wire ID>",
    "type": "<message type>",
    "thid": null,
    "pthid": null,
    "body": {},
    "attachments": []
  },
  "created_time": 1788442800,
  "expires_time": null,
  "please_ack": [""],
  "ack": [],
  "headers": {}
}
```

`please_ack` is either null, meaning the header is absent, or the exact ordered
array carried on the wire. Each string names a message whose explicit
acknowledgment is requested. The empty string means the current message; the
current wire ID MAY be used instead. An empty array requests no message ID.

For processing, replace each empty string with the current wire ID and ignore
later duplicate targets without reordering the first occurrence. A current
outbound is receipt-required exactly when that expanded target list contains
its own wire ID. An array that names only older messages does not make the
current message receipt-required.

For inbound normalization, absent `please_ack` is null and a present array is
preserved exactly. Absent `ack` is `[]`. Array order is wire order. `ack`
values are processed in oldest-to-newest receive order; duplicate values are
harmless and only their first occurrence has effect.

Phase-1 writers SHOULD omit an empty `please_ack` array and SHOULD NOT emit
duplicate targets, but readers MUST accept standard arrays including `[]`,
`[""]` and `[currentWireId]`.

`headers` contains every permitted DIDComm top-level header not represented by
a dedicated field. The reserved names `typ`, `id`, `type`, `from`, `to`,
`created_time`, `expires_time`, `thid`, `pthid`, `please_ack`, `ack`,
`from_prior`, `return_route`, `body` and `attachments` are forbidden.

`intentHash` is unpadded base64url SHA-256 of the RFC 8785 canonical
projection. A preparer copies all values from `message.out`; it MUST NOT
substitute its clock, change receipt policy, reorder arrays, add an unrelated
acknowledgment, invent a default header or drop an unknown supported header.

### 8.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of the exact complete RFC 8785
canonical innermost DIDComm plaintext encrypted by one package or received in
one observation. It includes `from`, `to`, `from_prior` and every other
present header.

Several packages or inbound observations of one logical message may have
different `plaintextHash` values while keeping equal `semanticHash` and
`intentHash`, but only when their package-level addressing and security
evidence independently validate under `distributed-delivery/1.0`.

The stored application document is itself UTF-8 RFC 8785 canonical JSON in a
raw DASL object. It is not required to preserve raw wire JSON.
The three hashes and the explicit durable headers preserve the distinctions
needed for convergence and auditing.

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
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "target": {
      "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da"
    },
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "thid": null,
    "pthid": null,
    "createdTime": 1788442800,
    "expiresTime": null,
    "pleaseAck": [""],
    "ack": [],
    "headers": {},
    "body": "bafkrei...body",
    "attachments": ["bafkrei...attachment"],
    "semanticHash": "a4XN_teuGtrU-thj2lhR84rFrY1ZDVtqt2FPBmEDQUY",
    "intentHash": "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA",
    "effectId": null
  }
}
```

`target` is exactly one of:

```json
{ "contact": "<cid>" }
```

or:

```json
{
  "channel": {
    "myKey": "did/.../key-agreement/0",
    "peerKey": "..."
  }
}
```

A contact target may select a rendezvous DID only when this is an explicit
initial-message send under `rendezvous.md`. Ordinary relationship messages
never select a rendezvous DID. A channel target is used for an unattributed
authenticated peer or a response pinned to one channel. A peer-key-null
channel cannot be used for an authenticated reply.

Requirements:

- `createdTime` is a durable UTC Epoch Seconds timestamp; a deterministic
  automatic effect may derive it from the triggering message;
- `expiresTime` is UTC Epoch Seconds or null and, when non-null, is strictly
  greater than `createdTime`;
- `pleaseAck` is null or an exact ordered array of strings; `""` and the
  current wire ID both request acknowledgment of the current message;
- `pleaseAck == []` requests no explicit message ID;
- writers SHOULD avoid duplicate targets and SHOULD use `""` rather than
  repeating the current wire ID, while readers preserve every accepted wire
  array exactly;
- the current message is receipt-required exactly when expansion of
  `pleaseAck` contains `wireId`;
- `ack` is an ordered array of message IDs in oldest-to-newest receive order;
- `headers` contains every otherwise-unmodeled supported top-level DIDComm
  header;
- `headers` MUST NOT contain `typ`, `id`, `type`, `from`, `to`,
  `created_time`, `expires_time`, `thid`, `pthid`, `please_ack`, `ack`,
  `from_prior`, `return_route`, `body` or `attachments`;
- `return_route` is forbidden in an innermost Estoc vault application
  message;
- `thid`, `pthid`, `expiresTime` and `effectId` are present with null when
  unused;
- `semanticHash` and `intentHash` are computed under section 8;
- `roots` is the distinct ordered set of `body` followed by `attachments`; and
- appending this event requires no network, resolver, mediator or socket.

A preparer MUST use the durable timestamp and exact headers. Version 3 emits
`typ`, `id`, `type`, `from`, `to`, `created_time` and `body`; emits `thid`,
`pthid` and `expires_time` when non-null; emits `please_ack` whenever
`pleaseAck` is not null, including `[]`; emits `ack` and `attachments` when
non-empty; and expands every `headers` entry at the plaintext top level.

More than one `message.out` under one `mid` is allowed only when every field is
identical. Reuse of one wire ID with a different semantic or intent projection
is an integrity conflict.

### 9.3 `message.prepared`

```json
{
  "type": "message.prepared",
  "roots": ["bafkrei...encrypted-envelope"],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "senderDid": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "recipientDid": "did:peer:4zQm...short",
    "peerResolution": "019b2a72-0626-7a87-a310-941fe4c1ce77",
    "fromPrior": null,
    "semanticHash": "a4XN_teuGtrU-thj2lhR84rFrY1ZDVtqt2FPBmEDQUY",
    "intentHash": "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA",
    "plaintextHash": "WkPpglZREjLGtviZ1L6c-R3EX1cTHtbe0sJrmhl77LQ",
    "envelope": "bafkrei...encrypted-envelope",
    "envelopeHash": "-7R5QBlmLhRVtCZlKz4FtGt35wd9d-9_cNe_NbdCMag"
  }
}
```

This event makes one exact normalized encrypted envelope recoverable by every
replica.

Requirements:

- `senderDid` names a live local DID entity selected for the target;
- `myKey` is a key-agreement key of the selected generation and authorizes
  the plaintext `from`;
- the plaintext `id`, semantic fields and immutable control headers equal
  `message.out`;
- `semanticHash` and `intentHash` equal the intent values;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- `peerResolution` names the exact `peer.resolved` evidence used to select
  the recipient key, or null only when the channel was already durably
  established without a fresh resolution requirement;
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization;
- `envelopeHash` hashes those bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

All packages for one `mid` MUST preserve semantic and intent hashes. A new
package MAY change `senderDid`, `myKey`, `recipientDid`, `peerKey`,
`peerResolution` or `fromPrior` only when the change follows a valid selected
DID/key generation or verified contact-scoped continuation for the same
logical target. Every such change requires a new package ID and plaintext
hash. A protocol may be stricter; one initial-message wire ID pins the
rendezvous DID snapshot and recipient generation.

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

`replacement` is nullable. Retirement stops automatic submission of that
package and releases its encrypted-envelope root when no other event holds
it. It does not terminate the logical message or another package.

### 9.5 `delivery.submitted`

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

### 9.6 `delivery.failed`

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

### 9.7 `delivery.held`

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

### 9.8 `delivery.released`

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

### 9.9 `delivery.acknowledged`

```json
{
  "type": "delivery.acknowledged",
  "roots": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
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

For an authenticated or signed innermost message:

```text
mid = UUIDv5(
  4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6,
  RFC8785(["v1", "authenticated", peerKey, wireId])
)
```

For a truly anonymous message:

```text
mid = UUIDv5(
  4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6,
  RFC8785(["v1", "anonymous", myKey, wireId])
)
```

This value identifies an observation namespace. The authenticated form omits
`myKey`, so a valid repack to another accepted local DID/key can converge
under one MID.

A verified contact-scoped transition may cause observations with different
authenticated `peerKey` values and therefore different MIDs to represent one
logical message. Section 14.8 defines that second-stage merge. The original
observation MIDs remain stored for audit and conflict detection.

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "mid": "ca6f6a41-454c-53ff-b827-1797156687cf",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "semanticHash": "eC9pbQTv_pbViy0dXQBZHEFVHybyZZyAfbJbhgwNoR8",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
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
- all three hashes are computed under section 8;
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
- `roots` is the distinct ordered set of body followed by attachments.

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

- equal semantic and intent hashes are one observation group;
- differing `receivedVia`, valid local recipient keys or valid complete
  plaintext hashes are package/replica observations;
- different semantic hash is an application-content integrity conflict;
- equal semantic hash but different intent hash is a control-intent conflict;
- different plaintext hashes are allowed only when each `from`, `to`,
  `from_prior` and resolution chain validates under the same logical target;
  and
- every conflict suppresses automatic application effects and disputed ACK
  handling until explicitly resolved.

After contact attribution, two authenticated MID groups with the same
`wireId` are merged as one logical message only when:

1. both attribute without conflict to the same contact component;
2. their authenticated peer DIDs/keys are joined by a verified
   contact-scoped `peer.transitioned` chain;
3. the semantic and intent hashes agree;
4. every package-level address and transition proof validates; and
5. neither group is already conflicted.

This transition-aware merge permits a sender to repack one logical wire
message after an authenticated key/DID continuation without displaying it
twice. Reuse of the same wire ID by an unrelated key, another contact or an
unverified transition remains a separate message or conflict.

When semantic and intent hashes agree, `ack` and `pleaseAck` are stable across
valid observations because they are inside the intent projection. Valid
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

### 10.4 Pickup versus ultimate acknowledgment

Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; every known local outbound wire ID in its validated `ack` array
may produce an idempotent `delivery.acknowledged`. A threaded or natural
response without an explicit `ack` array does not create that delivery
observation.

## 11. Peer and profile observations

All events in this section carry a complete channel key. Peer DID evidence is
kept distinct from contact decisions and from our own DID entities.

### 11.1 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "roots": ["bafkrei...resolved-did-document"],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "presentedDid": "did:web:alice.example",
    "did": "did:web:alice.example",
    "document": "bafkrei...resolved-did-document",
    "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos",
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
- `document` is exact RFC 8785 canonical resolved DID document JSON.
- `documentHash` is unpadded base64url SHA-256 of the object bytes.
- the authenticated `peerKey` must be present under the named DID and exact
  document;
- `authenticationKids` and `keyAgreementKids` are context, not independent
  evidence that every listed key controlled the observed message; and
- `service` is the selected DIDComm service URI or null.

For an initial message to a rendezvous DID, this event is the
initial-message-bound resolution snapshot. A later `from_prior` is verified against this exact event and object,
not an unrelated current web document. If the event or object is temporarily
missing, processing is deferred and retried after sync; absence is not proof
that the transition is invalid.

For a `did:peer:4` first disclosure, the implementation decodes and validates
`presentedDid`, derives `did` and the document locally, and stores both forms.
A short form received before corresponding long-form resolution evidence is
known cannot establish an authenticated relationship.

Equivalent duplicate observations are harmless. Same presented/canonical DID
and document hash with incompatible contents is an integrity conflict.

### 11.2 `peer.transitioned`

```json
{
  "type": "peer.transitioned",
  "roots": [],
  "data": {
    "scope": "relationship",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
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
fetch of a newer `did:web` document is not a substitute unless its canonical
hash exactly matches that snapshot. Missing snapshot material creates a
retryable deferred state; an invalid signature, claim, key or long form is a
conflict.

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
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement/0",
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
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "wireId": "019b2a85-090f-75a4-beb3-8440780d46e9"
  }
}
```

This observes that our profile was sent on the channel. Duplicate lifted
observations are harmless.

## 12. Rendezvous and relationship observations

These events lift durable state defined by the profile in `rendezvous.md`. The rendezvous DID,
relationship DIDs and generations are vault-scoped. A web publisher or server
replica has no special ownership.

### 12.1 `rendezvous.generationConfigured`

The default profile configures one immutable generation for a Peer rendezvous
DID:

```json
{
  "type": "rendezvous.generationConfigured",
  "roots": [],
  "data": {
    "id": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "keyGeneration": 0,
    "resolution": {
      "kind": "peer-long-form",
      "longForm": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document",
      "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos"
    },
    "authenticationKid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document#auth-0",
    "keyAgreementKid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z...rendezvous-input-document#agreement-0",
    "ingressRoutes": [
      "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
    ],
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

The named DID has role `rendezvous`. `resolution.kind` is:

- `peer-long-form` for the REQUIRED default Peer DID profile; or
- `web-revision` for the OPTIONAL `did:web` profile.

For `peer-long-form`, `longForm` is the exact validated self-resolving Peer
DID, `documentHash` is unpadded base64url SHA-256 of its RFC 8785 canonical
resolved DID document, and no `did.document*` event is involved. The
configured authentication/key-agreement IDs and the sole ingress route MUST
match the rendezvous long-form input document. `relationshipRoute` is
independent and is encoded only in responder relationship DIDs.

A Web variant changes only the resolution object, for example:

```jsonc
{
  "kind": "web-revision",
  "documentRevision": "019b2a5b-5ab4-7c15-8b86-50650b78558d",
  "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos"
}
```

For Web generation integer `N`, selected DID URL fragments are normative:

```text
<did:web>#authentication-N
<did:web>#key-agreement-N
```

They MUST resolve in the named document revision to the seed-derived keys for
`keyGeneration`.

Every generation freezes:

- the key-agreement method that decrypts new initial messages;
- the authentication method that signs relationship-level `from_prior`;
- exact resolution evidence;
- non-empty ingress routes;
- the independently selected route encoded into responder relationship DIDs;
- `initialMessageTypes`, a non-empty post-admission policy set that MUST
  include Trust Ping `ping`;
- an initial-message lifetime ceiling of at least 604800 seconds;
- an initial plaintext safety ceiling of at least 65536 canonical UTF-8 bytes;
  and
- admission policy.

`admissionPolicy` is `ask`, `auto` or `silent`. `ask` is the default. `auto`
requires implementation-documented positive `autoLimits`; `ask` and `silent`
use null.

The event is appended before remote exposure and does not alone make the
generation live:

- a Peer generation is live when its long form, decoded document, selected key
  IDs and ingress route validate, and every selected mediated ingress route is
  currently reconciled; and
- a Web generation is live only when the exact selected document revision is
  observed published and every selected mediated ingress route is currently
  reconciled.

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

Private keys, Peer long-form/document evidence or Web revision evidence remain
available through at least:

```text
maximum initial-message lifetime
+ mediator message retention
+ configured delivery safety margin
```

For a Web profile, the current document may stop selecting an old
key-agreement method for new initial messages. For either profile, pinned
packages and historical `from_prior` verification continue to use retained
evidence. Emergency compromise policy may intentionally shorten this
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

- `decision` is `accept`, `reject` or `ignore`.
- `because` is `user` or `policy`.
- `generation` is the live generation that decrypted and admitted the
  candidate.
- `initialMessageType` exactly equals the admitted `message.in.msgType`.
- `initiatorDid` is the canonical Peer DID numalgo-4 short form.
- `initiatorLongForm` is its validated first-disclosure long form.
- `inboundCreatedTime` and `inboundExpiresTime` equal immutable wire headers.
- accept requires `code == null` and the deterministic relationship ID.
- reject requires `relationship == null` and one stable code:
  `sender-did-conflict`, `unsupported-protocol`, `capacity`, `policy`,
  `not-accepted` or `expired`.
- ignore requires both `code` and `relationship` null.

The event `at` is parsed as an RFC 3339 instant. An accept is timely only when:

```text
decisionInstant = parseRFC3339(event.at)
expiryInstant   = UnixEpoch + inboundExpiresTime seconds
timely          = decisionInstant < expiryInstant
```

Equality is expired. A candidate reaching expiry before acceptance may only
receive a new reject or ignore decision.

Before acceptance is sealed, equal decisions are duplicates; one valid user
outcome outranks policy outcomes; contradictory user outcomes are a visible
conflict; and a timely policy accept outranks an automatic policy
`reject(code="expired")`. Reject decisions with different codes do not
conflict merely because of the code: after selecting the effective source,
choose the first present code in this precedence order:

```text
sender-did-conflict
unsupported-protocol
capacity
policy
not-accepted
expired
```

A valid deterministic handoff-response `message.out` referenced by
`relationship.established` seals acceptance. Once it exists, later reject or
ignore decisions remain visible notes but cannot change the relationship
outcome. Ending that relationship uses `contact.deleted`, DID retirement and
route unregistration.

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
    "handoffEffectId": "j0Ji1-6swFT6C0zHEv5XAE_ouM2A7p7iO707T3YcNfg",
    "handoffMid": "93a1a0e9-383c-5106-a995-10234a729f70",
    "handoffWireId": "bfbdcb31-4ebc-5c57-bbdf-c4d82352afed"
  }
}
```

This event seals responder relationship state for
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
- the handoff IDs name one valid deterministic `message.out` for
  `originInboundMid` that explicitly ACKs `originWireId` and requests its own
  ACK with `pleaseAck == [""]`.

The relationship, deterministic contact, channel attachments,
`contact.useDid`, responder `did.created`, this event and handoff
`message.out` SHOULD be appended in one batch. Equal statements are duplicates;
different values under one relationship ID are an integrity conflict.

A future multi-writer profile must coordinate origin selection before it can
claim convergence. Phase 1 has one active writer, so no remote race chooses a
different origin.

The responder repeats the exact stored `fromPrior` on every package from
`ourDid` until it receives an authenticated message addressed to `ourDid`.
Receipt-required handoff retry ends only after explicit ACK or another
terminal state.

## 13. Automatic effects

An inbound logical message may be delivered more than once. An automatic
handler computes:

```text
effectId = base64url(
  SHA-256(
    UTF8("estoc/effect/1\0") ||
    UTF8(mid) || 0x00 ||
    UTF8(handlerId) || 0x00 ||
    UTF8(effectKind) || 0x00 ||
    UTF8(decimalOrdinal)
  )
)
```

The same logical input and handler action MUST produce the same `effectId`.
A protocol MAY define a stricter effect scope. The rendezvous profile derives
stable relationship state from `(rendezvous DID, peer key)`, while each actual
deterministic response is an effect of its triggering inbound message.

- Automatic contacts use the deterministic contact rule in section 7.
- Automatic outbound messages derive stable `mid` and `wireId` values in
  section 9.
- Handler-produced events SHOULD include `effectId` when their schema permits
  diagnostics and duplicate recognition.
- An external system call MUST use `effectId` as its idempotency key or
  explicitly accept at-least-once side effects.

The pure ACK effect is fully fixed by `distributed-delivery/1.0`:

```text
handlerId = https://estoc.dev/distributed-delivery/1.0#pure-ack
effectKind = pure-ack
ordinal = 0
createdTime = triggering message.createdTime
expiresTime = null
thid = triggering thid, or triggering wireId when thid is null
pthid = triggering pthid
pleaseAck = null
ack = [triggering wireId]
headers = {}
body = {}
attachments = []
```

For triggering MID
`019b1b61-2e26-7a8f-8f29-a4d86a82dbd4`, the effect ID is
`Pq2QwoCogLZIy8AtxGjbmtwAKdQyJoCatxh8IjL3o7o`, the outbound MID is
`db2107e1-e230-5efb-808e-7fa065054f73`, and the wire ID is
`5627527e-2820-5935-9d91-7e0181838aa9`.

A Trust Ping handoff response uses:

```text
handlerId = https://didcomm.org/trust-ping/2.0
effectKind = ping-response
ordinal = 0
```

For triggering inbound MID
`ca6f6a41-454c-53ff-b827-1797156687cf`, the effect ID is
`j0Ji1-6swFT6C0zHEv5XAE_ouM2A7p7iO707T3YcNfg`, the outbound MID is
`93a1a0e9-383c-5106-a995-10234a729f70`, and the wire ID is
`bfbdcb31-4ebc-5c57-bbdf-c4d82352afed`.

Every deterministic handoff response freezes timing per triggering message:

```text
response.createdTime = triggering message.createdTime
response.expiresTime = triggering message.expiresTime + 604800
```

Its `fromPrior.iat` is **not** the response time. It is copied from
`relationship.established.rotationIat`, which equals the relationship origin's
`createdTime`. The addition fails closed on integer overflow. Acceptance still
must be committed before the triggering message expires.

Human-authored content is never selected as the deterministic handoff response.
It is ordinary later traffic and carries the frozen relationship proof while
handoff remains unconfirmed.

Phase 1 makes no distributed exactly-once claim. Process retry and mailbox
redelivery are controlled by deterministic effect IDs.

## 14. Folds

All folds accept events in any order and are deterministic over the set.
Canonical order is used only where stated.

### 14.1 Runtime-author fold

Phase 1 expects exactly one active local `replica_id`. For each author seen in
the event set, the fold reports `firstEventAt` and `lastEventAt`. An author
fork is an event-store integrity condition, not a normal multi-writer merge.

`replica.label` and `replica.retired` are reserved for the deferred
multi-replica profile. A phase-1 implementation MAY preserve them but does not
need to act on them.

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
- referenced by a non-retired mediated route that is bound to a live peer
  DID, appears in the selected route set of a live DID, appears in a selected
  web document revision, or belongs to a non-retired rendezvous generation.

The active runtime reconciles recipients and drains account-scoped pickup on
every reachable mediation in this set. A hosted runtime receives no special
ownership.

### 14.3 Sync-store fold (deferred)

This fold is reserved for `vault-sync/1.0` and is not required by phase 1.
Implementations that preserve the deferred events group them by configuration
ID, reject conflicting `sync.configured` values and treat any
`sync.retired` as terminal. No phase-1 local commit depends on a sync store.

### 14.4 Route, DID, key-generation and document fold

For each route ID:

- exactly one consistent `route.configured` defines the reusable transport;
- any `route.retired` makes it terminal; and
- conflicting configuration values make it unusable and visible as a
  conflict.

For each DID entity ID:

- exactly one consistent `did.created` defines DID string, method, role,
  generation-0 keys and optional peer bound route;
- `did.keyGenerationAdded` contributes immutable later generations;
- selected key generation is the latest valid
  `did.keyGenerationSelected`, or generation 0 when none exists;
- selected route order is the latest valid `did.routesSelected`, or the peer
  DID's bound route when the method is `peer`;
- registration history is grouped by `(DID, route, registrationId)`;
- disclosures are every valid `did.disclosed` in canonical order;
- web document revisions are grouped by revision ID;
- selected web revision is the latest valid `did.documentSelected`;
- publication observations are grouped by `(revision, documentHash, url)`;
  and
- any `did.retired` makes the DID entity terminal.

The fold verifies all of the following:

- each key name uses the DID entity and declared generation;
- the seed-derived public keys match the peer DID or prepared web document;
- a Peer DID numalgo-4 entity stores a valid long form and its derived
  canonical short form, has exactly one configured non-retired bound route,
  and does not add later key generations;
- a web DID has null `longForm` and `boundRoute`, every selected revision has
  the correct DID `id`, and a rendezvous profile exposes exactly one current
  key-agreement generation for new initial messages;
- each web generation uses the normative `#authentication-N` and
  `#key-agreement-N` fragments;
- every selected route is configured and non-retired;
- one DID does not select two mediated routes backed by the same mediation;
- every mediated route references a usable mediation;
- every document-listed key generation and route exists; and
- document hash and object bytes agree.

A single route may be selected by many DIDs. This is transport reuse, not DID
or contact equivalence.

The desired mediator recipient set contains each `(DID string, mediated
route)` pair required by a live DID, selected document or rendezvous
generation. `did.routeRegistered` and `did.routeUnregistered` are audit
observations only; the phase-1 runtime queries each mediator and reconciles
that desired set with ordinary Coordinate Mediation `recipient-query` and
`recipient-update`. A future mediator profile may additionally require a
recipient-control proof.

Direct routes do not enter that set. They remain alternate transport paths to
the same vault-scoped DID and do not name replicas.

A web publication is current only when an HTTPS fetch returns bytes matching
the selected revision and DID `id`. Historical `did.documentPublished`
events do not suppress reconciliation after startup or remote change.

The fold also maintains a reverse map from every local communication key name
to exactly one DID entity and generation. Ambiguous or inconsistent mapping
is an integrity conflict and prevents cryptographic use.

### 14.5 Rendezvous and relationship fold

For each rendezvous generation, require one consistent
`rendezvous.generationConfigured` and valid DID/key/route dependencies. Its
live state is method-specific:

- Peer profile: stored long form and decoded input document match configured
  keys and ingress route, and every selected mediated ingress route is
  currently reconciled;
- Web profile: the exact selected revision has a matching
  `did.documentPublished` observation, and every selected mediated ingress
  route is currently reconciled.

`rendezvous.generationRetired` supplies terminal `admitUntil`. Missing key or
event state, or a configured generation that can still become live, is
**deferred** and leaves mediator delivery unacknowledged. A terminally retired
or permanently invalid generation is a pre-vault rejection.

Group `relationship.admissionDecided` by `inboundMid`. Discard structurally
invalid decisions and accepts whose parsed RFC 3339 event `at` is not strictly
before the Epoch-Seconds inbound expiry.

Before acceptance is sealed:

1. equal decisions are duplicates;
2. one valid user outcome outranks policy outcomes;
3. contradictory user outcomes are a visible conflict;
4. a timely policy accept outranks an automatic policy reject with code
   `expired`;
5. equal reject outcomes never conflict merely because their codes differ;
   select code by the fixed precedence in section 12.3; and
6. other incompatible effective outcomes remain visible conflicts.

A valid `relationship.established` plus its named deterministic handoff
`message.out` seals acceptance. Later rejection or ignore remains visible but
cannot undo materialized relationship state. Rejection never creates a custom
rendezvous decline.

Group `relationship.established` by deterministic relationship ID. Equal
values are one relationship. Different values are an integrity conflict. The
event itself freezes origin, generation, remote DID, route, rotation proof and
handoff IDs; these are not re-selected from later arrivals.

A valid relationship contributes:

- one deterministic contact;
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
component and must name the exact historical resolution evidence used to
verify `from_prior`. Likewise, `contact.peerDidAdded` is an outbound contact
decision, not global control evidence.

Exclude mediation channels from contact attribution.

For a channel, collect every live `contact.attached` whose channel lies in its
evidence component, then collapse contact IDs by `contact.merged`:

- none: unattributed;
- one contact component: attributed to it;
- several: multi-valued attribution conflict.

The fold never attributes an anonymous `peerKey == null` channel through the
graph.

Within one contact component, apply valid `peer.transitioned` events as a
directed relationship graph. A transition replaces its predecessor only in
that component. Several unretired current ends are a visible relationship
conflict.

### 14.7 Contact fold

Contact merge edges form undirected connected components. The reported
representative is the lexicographically smallest non-deleted `cid`; if all
are deleted, the smallest `cid` is retained as the hidden tombstoned
representative.

For one component:

- deleted when every known member has a `contact.deleted` tombstone;
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

### 14.8 Inbound message fold

First group `message.in` by deterministic observation `mid`.

For each MID group:

- equal `semanticHash` and `intentHash` is one observation group;
- collect every distinct valid plaintext hash, receiving channel,
  `receivedVia` and author observation;
- different semantic hash is an application-content integrity conflict;
- equal semantic hash with different intent hash is a control-intent
  integrity conflict;
- a plaintext variant is accepted only when its package-level address and
  security evidence validate;
- erasure is applied before object presence; and
- any conflict suppresses automatic effects and disputed ACK processing.

After contact attribution, union two authenticated MID groups into one
logical message when they have the same `wireId`, attribute to the same
non-conflicted contact, and their authenticated peer keys are connected by a
verified contact-scoped `peer.transitioned` chain. Their semantic and intent
hashes must agree and all package-level evidence must validate. This is the
only cross-peer-key wire-ID merge. Unrelated or unverified key reuse remains
separate or conflicted.

A conforming `https://didcomm.org/empty/1.0/empty` pure ACK is retained as a
control observation and its validated `ack` array is processed, but it is
excluded from thread display, unread counts, notifications and
application-content handlers.

A user-visible thread contains each remaining logical application message
once, positioned by the earliest canonical observation unless an application
protocol defines another display time.

### 14.9 Outbound message and delivery fold

Group `message.out` by `mid`. Multiple identical intent events are one logical
outbound. Different fields, semantic hash or intent hash under one `mid` are a
conflict.

For a valid outbound:

- `packages[]` is every consistent `message.prepared` by `packageId`;
- all packages agree on `wireId`, `semanticHash` and `intentHash`;
- packages may differ in plaintext hash, sender/recipient DID, keys and
  `fromPrior` only under validated repack rules;
- one package is inactive after `message.packageRetired` or a package-scoped
  non-retryable failure;
- unresolved holds are exact `delivery.held` events not named by
  `delivery.released`;
- expand `message.out.pleaseAck` by replacing `""` with the outbound wire ID;
  `receiptRequired` is true exactly when the result contains that wire ID;
- `acknowledged` is true if a valid authenticated inbound `ack` names the wire
  ID on an allowed contact-scoped continuation and all proof gates pass;
- `submitted` is true if any package has `delivery.submitted`;
- a message-scoped non-retryable failure, including expiry, permanently ends
  new automatic preparation/submission for that intent;
- for `receiptRequired == false`, the first successful submission also ends
  automatic background retry for the current message;
- a valid ACK arriving after expiry sets `acknowledged == true` and derives
  `late == true`, but does not reactivate work; and
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

An OOB disclosure with `uses == "one"` is open when:

- its DID is not retired; and
- no live `contact.attached` names its `oobId`.

It is taken by the resulting contact component. Concurrent valid takes are
visible; deterministic automatic IDs prevent duplicate takes of the same
authenticated initial message but cannot prevent distinct peers from using a copied
one-use invitation.

A `uses == "many"` rendezvous disclosure remains open until its DID is
retired or publication policy closes it. It does not disclose a relationship
DID.

### 14.11 Extension fold

For each `ext`:

- installed if a consistent `extension.installed` exists;
- removed if any `extension.removed` exists after installation;
- purged if any `extension.purged` exists; and
- purged is terminal.

The application applies every pending purge before opening or executing
extensions.

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

The application computes the roots passed to `ObjectStore.collect`.

A root is held when at least one accepted event retains it through
`event.roots`, except:

- a root dropped by `message.erased` is not held by that message;
- a `message.prepared` envelope is not held after its package is retired;
- all prepared-envelope roots for a message cease to be held after the
  message is acknowledged, unless another event independently retains
  them; and
- an extension store computes its held roots from its own event set.

Unknown event types retain every exact root CID in their `roots` for the life
of the event set because version 3 defines no erase rule for them. A Tag 42
link inside a DRISL object is not a retention edge unless its CID also appears
in an accepted event's `roots`.

An object may be collected only when its exact CID is absent from the held-root
set and the backend's orphan grace has elapsed. DRISL links are not traversed.

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
3. load or mint local `replica_id` and `store_generation`;
4. acquire the exclusive writer lock for this vault copy;
5. fold portable state and extension lifecycle;
6. derive every required mediation account;
7. reconcile every required mediated recipient through ordinary Coordinate
   Mediation;
8. drain the ordinary account-scoped Message Pickup queue;
9. reconcile selected `did:web` document revisions when this runtime has
   publication authority; and
10. start live delivery, publication and retry workers independently.

Phase 1 MUST NOT require `replica-mediation/1.0` or `vault-sync/1.0`. Failure of
one mediator or Web publisher MUST NOT prevent offline local vault use or
communication through another configured route.

A server holding the seed follows exactly this procedure and is the one active
full runtime. A remote thin client without the seed does not.

### 16.2 Establish mediation

1. append `mediation.created` before the network request;
2. derive its vault-scoped account key;
3. perform ordinary Coordinate Mediation;
4. on grant, append `mediation.granted`;
5. reconcile selected recipient DIDs through Coordinate Mediation; and
6. append `mediation.selected` when policy chooses it for new mediated routes.

The phase-1 runtime uses ordinary account-scoped Message Pickup. It sends no
`replica_id` to the mediator. A network failure after step 1 leaves a retryable
intent, not a half identity.

### 16.3 Configure a sync store (deferred)

`sync.configured`, `sync.selected` and `sync.retired` are reserved for the
deferred `vault-sync/1.0` profile. Phase 1 neither needs nor performs this
procedure. Recovery uses the readable vault folder plus independently backed
up seed/recovery material.

### 16.4 Create a relationship DID

This procedure is used by an initiator before rendezvous and by protocols that
create ordinary pairwise relationships.

1. choose one configured live route, creating it first when necessary;
2. mint a UUIDv7 DID entity ID unless a protocol requires deterministic
   UUIDv5;
3. derive generation-0 authentication and key-agreement keys;
4. construct Peer DID numalgo 4 from those keys and route;
5. derive and retain both its long form and canonical short form;
6. append `did.created` with `did == short form`, `longForm == long form`, role
   `relationship` and the bound route;
7. append `did.routesSelected` when required; and
8. associate the DID entity with the intended contact through
   `contact.useDid`.

For a mediated route, register the canonical short form and append
`did.routeRegistered` before first disclosure. The first DIDComm message that
reveals the relationship DID MUST use the long form; subsequent messages and
mediator registration use the short form.

Changing keys or bound route creates a new relationship DID and a
contact-scoped transition. The existing DID entity is not edited.

### 16.5 Configure and disclose a rendezvous DID

The default Peer profile requires no domain or network resolver:

1. create or choose one reusable route, usually mediated;
2. mint a UUIDv7 DID entity ID and derive generation-0 authentication and
   key-agreement keys;
3. build and validate a `did:peer:4` long form whose input document embeds
   those keys and exactly that route;
4. append `did.created`, `did.routesSelected` and
   `rendezvous.generationConfigured` with canonical short form, exact long
   form, resolution hash, exact `initialMessageTypes`, admission policy and
   limits;
5. register the canonical short form on every mediated ingress route and
   append `did.routeRegistered`; and
6. append `did.disclosed`, exposing only the rendezvous Peer DID long form in
   an OOB invitation, QR, file or another discovery object.

The Peer generation is live after local long-form validation and current route
reconciliation. If the active runtime temporarily cannot map the recipient
key, it leaves the mediator delivery unacknowledged until local state is
repaired and refolded.

The optional Web facade instead:

1. chooses a `did:web` string under a controlled domain/path;
2. derives keys and appends the Web `did.created` entity;
3. configures/selects routes;
4. stores exact canonical `did.json`, then appends
   `did.documentPrepared`, `did.documentSelected` and
   `rendezvous.generationConfigured` with `resolution.kind ==
   "web-revision"`;
5. publishes and fetch-verifies the document;
6. reconciles mediated recipient registration;
7. appends `did.documentPublished` after verification; and
8. optionally appends `did.disclosed` for a reusable URL, OOB invitation or
   directory profile.

The Web generation is live only after selected revision and all mediated
registrations verify. In both profiles the rendezvous DID belongs to the
vault, not the process displaying the invitation or serving `did.json`.

### 16.6 Send an initial message

1. learn a rendezvous DID through OOB, QR, directory, file or manual input;
2. create/select a contact and append `contact.peerDidAdded` for that DID;
3. create one local relationship `did:peer:4`, retain both forms and associate
   it with the contact;
4. select a first application message; when no application content exists,
   use Trust Ping 2.0 `ping` with `response_requested == true`;
5. write body/attachments and append `message.out` with finite expiry,
   `pleaseAck == [""]`, OOB invitation ID as `pthid` when applicable, and all
   hashes; this may happen offline;
6. after intent exists, register the initiator relationship DID canonical
   short form on selected mediated routes;
7. resolve the rendezvous DID and append exact `peer.resolved` evidence;
8. append `channel.firstSeen` and `contact.attached` for the bootstrap channel
   with `because == "rendezvous"`;
9. prepare using initiator Peer DID long form in plaintext `from`, protected
   `skid` and decoded `apu`; and
10. submit against the pinned generation with bounded retry until explicit
    ACK, expiry, hold or the rendezvous retry ceiling.

The first message is the real Trust Ping or application message, not a custom
rendezvous wrapper. `pleaseAck == []` is legal DIDComm but requests nothing and
is not used by the conforming phase-1 writer for bootstrap.

If current time reaches expiry before preparation or retry, append
message-scoped non-retryable `delivery.failed(code="expired")` and submit
nothing. A replacement initial message uses a new wire ID but normally reuses
the same initiator relationship key unless the contact was deleted.

The rendezvous DID is never placed in ordinary `writeTo`; only this explicit
bootstrap procedure targets it.

### 16.7 Admit and establish a relationship

For a delivery addressed to a rendezvous key:

1. attempt decryption using protected recipient `kid`;
2. when the key/generation is absent, or configured but not live and still
   capable of becoming live, retain the delivery unacknowledged and retry
   after local state changes;
3. after authenticated decryption, run `rendezvous.md`'s hard pre-vault gate
   before `message.in`;
4. a safely classified hard rejection received through Message Pickup MUST be
   pickup-ACKed and leaves no portable message/contact/relationship state;
5. for an admitted candidate, store retained bytes, append `message.in`, then
   ACK the account-scoped mediator delivery;
6. append or await `relationship.admissionDecided` according to `ask`, `auto`
   or local policy; and
7. do not materialize a relationship while the effective decision is
   conflicted.

An accept is valid only when its decision event instant is strictly before the
candidate's Epoch-Seconds expiry. Equality is expired. After expiry, a new
decision can only reject or ignore.

For effective reject or ignore, create no relationship DID. Rejection may be
silent or may produce a deterministic protocol error or Report Problem intent,
which is appended before resolution, preparation or submission. Once every
selected rejection effect no longer needs the candidate content, append
`message.erased` for all roots retained solely by that candidate.

For effective accept:

1. derive stable relationship, contact and local pairwise DID IDs from the
   canonical rendezvous DID and authenticated initiator key;
2. reject acceptance when the deterministic contact is tombstoned or the same
   key presents another canonical initiator DID;
3. derive/reuse the responder relationship DID using its independently
   selected relationship route;
4. select a deterministic handoff response: Trust Ping `ping-response`, a
   protocol-defined deterministic response, or Empty Message ACK;
5. append, preferably in one batch, the admission decision, any new
   `contact.created`, bootstrap/pairwise `contact.attached`, `did.created`,
   `contact.useDid`, fully frozen `relationship.established`, and deterministic
   response `message.out`;
6. response intent explicitly ACKs the triggering initial wire ID, uses
   `pleaseAck == [""]`, and carries the exact relationship-level `fromPrior`;
7. only after the durable batch, register responder pairwise DID canonical
   short form;
8. prepare with long-form first-disclosure sender evidence; and
9. submit with bounded retry until explicit ACK, expiry or hold.

The first valid handoff-response intent seals acceptance. A later user reject
is retained as a visible note but cannot retroactively dismantle the
relationship; the user ends it through ordinary contact deletion and DID/route
retirement.

Repeated initial messages from the same stable initiator key reuse the
relationship but remain separate application messages. Until an authenticated
message arrives at the responder pairwise DID, every package from that DID to
the contact uses its long form and carries the exact frozen `fromPrior`.
Human-authored messages are ordinary traffic; they never determine the
handoff proof or rotation instant.

### 16.8 Send an ordinary message

The synchronous full-vault send operation:

1. writes attachment objects;
2. writes the stored message document;
3. selects durable `createdTime`, optional `expiresTime`, exact `pleaseAck`
   value (null or array), exact ordered `ack`, and complete `headers`;
4. computes semantic and intent hashes;
5. rejects a rendezvous DID as an ordinary relationship target;
6. appends `message.out`; and
7. returns `mid` and `wireId`.

It performs no network operation. Expand `pleaseAck` by replacing `""` with
the current wire ID. Receipt-required completion is selected only when that
expanded set contains the current wire ID. `null`, `[]`, or an array naming
only older messages is submission-terminal for the current message.

The active phase-1 runtime may later:

1. stop when held, acknowledged, terminally failed, expired, or
   submission-terminal and already submitted;
2. fold target contact/channel;
3. choose valid sender DID, peer DID/key and exact resolution evidence;
4. attach the frozen contact-scoped `fromPrior` while pairwise handoff remains
   unconfirmed;
5. construct complete plaintext by copying every intent-time header;
6. compute plaintext hash, encrypt, store exact envelope and append
   `message.prepared`;
7. submit directly or through Routing 2.0 with `packageId == forward.id`;
8. append submitted or failed observation; and
9. retry according to completion mode.

A new package may change address/security evidence only under validated repack
rules while preserving semantic and intent hashes. Receiving may join equal
wire IDs across a verified peer-key transition in one contact.

### 16.9 Receive a message

For every account-scoped pickup or direct delivery:

1. if the ultimate key is locally unknown, or belongs to a configured
   rendezvous generation that may become live but is not live, keep the
   delivery pending and retry after local state changes without pickup ACK;
2. authenticate, decrypt and validate the complete innermost message,
   including Peer DID long-form and authcrypt sender evidence;
3. when addressed to a rendezvous DID, run section 16.7's bounded pre-vault
   gate; a safely classified hard rejection received through Message Pickup
   MUST be pickup-ACKed without `message.in`;
4. for admitted or ordinary traffic, derive channel, observation MID,
   semantic hash, intent hash and exact plaintext hash;
5. write retained body/attachment objects and the stored message document;
6. append `message.in` durably with applicable `channel.firstSeen`, exact
   `peer.resolved`, contact attachment and non-controversial observations;
7. only then ACK the account-scoped mediator delivery;
8. before processing ACK values or continuation, validate every package-level
   proof; for an unknown DID carrying `from_prior`, validate exact pinned
   historical evidence first;
9. after validation, append `peer.transitioned` when applicable and process
   explicit `ack` values into idempotent `delivery.acknowledged`;
10. schedule deterministic application effects or
    `relationship.admissionDecided`;
11. expand `pleaseAck`; when at least one requested ID will be honored, create
    or reuse a deterministic protocol response or pure-ACK effect; and
12. on duplicate receipt, re-submit the same already-prepared response package
    rather than creating another effect or package.

Steps 5–6 SHOULD use one atomic batch. A conforming pure ACK is retained for
audit and delivery processing but excluded from user threads, unread counts,
notifications and application handlers. It has `pleaseAck == null`, so first
successful submission ends normal retry.

A crash before durable message commit leaves mediator delivery pending. A
crash after commit but before pickup ACK causes redelivery and another valid
duplicate observation.

### 16.10 Replica retirement and re-incarnation (deferred)

This procedure belongs to `replica-mediation/1.0` and is not required by phase
1. The phase-1 mediator does not know `replica_id`; local restore or exact move
rules are defined by `vault-folder.md`. A future implementation MUST define
terminal mediator retirement and local re-incarnation before enabling
per-replica pickup.

### 16.11 Erase a message

1. fold every root currently retained by the logical message and its prepared
   packages;
2. append one or more `message.erased` events naming the requested roots;
3. refold held roots; and
4. call object collection.

Late duplicate observations may introduce another event retaining the same
logical roots. The active runtime that observes an existing erase MUST append
an equivalent erase for newly learned roots of that message before those roots
are considered intentionally released. A future replicated profile applies the
same closure rule in every full copy.

### 16.12 Delete a contact

1. append `contact.deleted` for every currently known member of the contact
   component, preferably through `appendAll`;
2. for every message exactly attributed to the component, append erases for
   body, attachment and prepared-envelope roots required by policy;
3. retire relationship DIDs exclusively associated with the deleted
   component;
4. retire or unregister their routes;
5. preserve a shared rendezvous DID unless separately retired; and
6. collect unheld objects after grace.

A later merge cannot revive a tombstoned member. A newly discovered component
member or late message requires the same idempotent cleanup procedure.

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

After event union, copy only valid absent objects whose exact CIDs are in the
held-root set computed by the merged fold. No DRISL link traversal is implied. An erased relation does not revive merely because an
older source still has the bytes.

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
Mediation, drains the account-scoped mailbox, and continues every non-held,
non-acknowledged outbound message.

If the restored runtime has deployment authority for a selected optional
`did:web` rendezvous facade, it may reconcile and publish the same selected
document revision. A runtime without publication authority can still use every
established pairwise relationship and mediated route.

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
  audience. A Peer profile avoids DNS resolution; an optional Web profile also
  exposes DNS, publisher and resolver metadata.
- A relationship DID SHOULD be disclosed only through encrypted interaction
  and MUST NOT appear in a reusable public invitation or rendezvous DID
  document.
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
- Ordinary `did:web` publication depends on DNS, HTTPS and deployment
  authorization. Vault events preserve desired and observed revisions but do
  not provide an append-only Web DID history.
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
9. Semantic hash covers application ID/type/thread/body/ordered attachments;
   intent hash additionally covers immutable control headers; plaintext hash
   covers one exact DIDComm plaintext.
10. Two packages may differ in valid address/security evidence while agreeing
    on wire ID, semantic hash and intent hash.
11. Retrying one package preserves identical plaintext, envelope and package
    ID.
12. HTTP success produces `delivery.submitted`, never acknowledgment.
13. A deterministic response acknowledges an outbound only when authenticated
    explicit `ack` names its wire ID.
14. Expiry irreversibly ends work; later valid evidence may display
    acknowledged-late without restarting it.
15. Equal authenticated variants derive one observation MID. Equal wire IDs
    under transition-verified peer keys in one contact merge only at the
    logical-message layer.
16. Semantic/intent conflicts suppress disputed automatic effects and ACK
    processing.
17. Pure Empty ACK is retained and processed but excluded from threads,
    unread counts, notifications and application handlers.
18. Pure ACK has `pleaseAck == null`; its first successful submission is
    terminal and creates no ACK loop.
19. Duplicate receipt of a message whose requested IDs were already honored
    re-submits the same prepared response/ACK package.
20. Account-scoped Pickup ACK follows durable message/object commit for
    admitted traffic.
21. Ciphertext for an unknown or configured-but-not-live rendezvous generation
    remains unacknowledged and is retried after local state changes.
22. Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.
23. `peer.resolved` retains exact canonical document bytes/hash,
    presented/canonical DID forms and selected key IDs.
24. Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
25. A reusable invitation contains a rendezvous DID and no relationship DID;
    the default Peer path requires no DNS or Web DID.
26. Every implementation hard-gate accepts valid initial plaintext up to
    65536 bytes and positive lifetime up to 604800 seconds, subject only to
    emergency resource and abuse limits.
27. Trust Ping `ping` is always supported; protocol preference and missing
    current-message receipt request are post-admission policy, not silent
    hard-gate rejection.
28. The first bootstrap message is an ordinary application message, not an
    Estoc rendezvous wrapper.
29. `relationship.admissionDecided` records a local accept/reject/ignore and
    rejection code; differing reject codes use deterministic precedence.
30. Two initial wire IDs from the same `(rendezvous DID, initiator key)` derive
    one relationship/contact/responder DID and remain separate messages.
31. A deterministic contact tombstone is not resurrected; reconnect requires a
    fresh initiator relationship key.
32. Event `at` is parsed as RFC 3339 and compared with Epoch-Seconds expiry as
    an instant; equality is expired.
33. A valid deterministic handoff response intent seals acceptance. Later
    rejection is a visible note; ending the relationship uses contact deletion.
34. Stable `relationship.established` freezes origin, exact prior form/kid,
    responder long form, relationship-level rotation `iat`, `fromPrior` and
    handoff IDs.
35. `from_prior.iss` uses the exact invitation/snapshot form and its protected
    `kid` belongs to that exact DID.
36. `from_prior.sub` equals plaintext `from` byte-for-byte; before confirmation
    both use responder Peer-DID long form.
37. The initiator validates `iat` against one of its retained initial-message
    `createdTime` values and verifies the corresponding pinned snapshot before
    applying ACK or transition.
38. Response intent precedes pairwise recipient registration, and registration
    precedes submission.
39. Trust Ping is the default no-content initial message; an application
    message may be first without wrapping.
40. A handoff response is deterministic, explicitly ACKs the trigger, requests
    its own ACK with `pleaseAck == [""]`, and carries frozen `fromPrior`.
41. Human-authored content is ordinary later traffic and does not choose the
    relationship origin or rotation time.
42. Until an authenticated message arrives at responder pairwise DID, every
    package from it carries the same `fromPrior` and uses long-form sender
    spelling.
43. A rejected/ignored durable candidate eventually releases its content roots
    through `message.erased`; the skeleton remains.
44. A rendezvous DID is excluded from ordinary `writeTo`; the initial-message
    procedure is the only ordinary sender path targeting it.
45. Contact-scoped transition does not globally retire or union the rendezvous
    DID with unrelated relationships.
46. Peer rendezvous and relationship DIDs may use different mediation routes.
47. `did.routeRegistered` and `did.documentPublished` are observations that
    reconnect must revalidate.
48. Established pairwise traffic remains usable when an optional Web publisher
    is unavailable.
49. Erasure is checked before object presence; late roots receive equivalent
    erasure closure.
50. Restore from a readable folder creates a new local author unless it is an
    exact move, reconciles standard mediation/pickup and resumes eligible
    outbox work.
51. Phase 1 requires neither `replica-mediation/1.0` nor `vault-sync/1.0`.
52. Shuffling the same event set leaves every phase-1 fold result unchanged.
