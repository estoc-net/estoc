# The Estoc vault events, version 3

Status: **draft** — clean-break event vocabulary and fold rules for one
single-seed vault with concurrently writable replicas.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

Every example below is the `type`, `blobs` and `data` portion of an event
whose complete envelope is defined by `event-store.md`. A known event
type has a closed payload schema in version 3. The store itself validates
only the envelope; the vault layer validates the payload before append
and after ingest.

This document defines portable vault state. Socket state, pickup cursors,
retry timers, caches and traces are local state and do not appear here.

## 1. Model

A vault is one identity with one seed and any number of trusted full
replicas. Every unlocked full replica can derive and use the same
communication and mediation keys.

A replica is only:

- an event author;
- a mediator pickup and acknowledgment scope; and
- a local execution context.

It is not a hardware identity or security boundary. No separate host
identity exists, and no replica-creation event is required.

The event model distinguishes three kinds of durable statement:

- **intent** — a user or policy decision that must survive offline and
  process failure, such as `message.out` or `contact.petname`;
- **observation** — a fact learned from authenticated bytes or an
  external service, such as `message.in`, `mediation.granted` or
  `delivery.acknowledged`; and
- **materialization** — retryable work made durable, such as the exact
  ciphertext named by `message.prepared`.

All current views are folds over immutable events. No portable mutable
record is authoritative.

## 2. Principles

1. **Intent precedes effects.** A user-visible action is committed as an
   event and referenced blobs before DNS, DID resolution, encryption or
   network submission begins.
2. **Observations carry their evidence boundary.** A peer observation
   carries the local and peer keys authenticated by the envelope. A
   mediator observation names the mediation arrangement that produced
   it.
3. **No event depends on the current replica.** Folds over portable vault
   state have no `self` parameter. Event `author` is provenance, not
   ownership of communication state.
4. **Mediation and communication keys are vault-scoped.** Any full
   replica may derive them, reconcile recipient registration, receive
   and continue pending delivery.
5. **Stable IDs make retries safe.** A logical message, an encrypted
   package and a mediator delivery have different IDs and different
   lifetimes.
6. **At-least-once is expected.** More than one replica may receive,
   prepare, submit or process the same logical message. Folds and
   handlers must be idempotent.
7. **Conflicts are visible projections.** Concurrent decisions remain
   events. A fold uses set semantics, explicit references or canonical
   latest-wins exactly where this document says so.
8. **Events are permanent; content may be erased.** An erase releases
   blob roots. It never deletes a skeleton event.
9. **A retired replica remains historical truth.** Retirement affects
   future mediator delivery policy, not event validity or seed
   possession.
10. **A mediator or sync store is not the vault.** Mailbox ciphertext has
    bounded retention. The event/blob set is the recoverable identity
    state.

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

Each writable full vault runtime has one canonical UUIDv7 `replica_id`.
Every event it appends has:

```text
event.author = local replica_id
```

A full runtime may execute in an end-user application or on a server. Its
location does not change event semantics. No creation event or separate host
identity is required.

A portable restore or sync bootstrap mints a new replica ID. An exact move
may preserve one only when the old writer is gone. If two writable copies
share an author, `event-store.md` detects a fork when their event sets meet.

A remote client that does not hold the seed is not a full replica, has no
event author and cannot turn a staged command into portable vault state by
itself.

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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "route": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "registrationId": "019b2a55-bae7-705a-baea-45782de39809"
  }
}
```

This is an observation that the mediator behind the named route accepted
recipient-control registration for the named DID string under
`replica-mediation/1.0`.

It is not permanent proof of current mediator state. Every connection
queries and reconciles the desired `(DID, route)` set from the converged
vault fold.

#### `did.routeUnregistered`

```json
{
  "type": "did.routeUnregistered",
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": ["bafy...did-document"],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "revision": "019b2a5b-5ab4-7c15-8b86-50650b78558d",
    "previous": null,
    "document": "bafy...did-document",
    "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos",
    "keyGenerations": [0],
    "routes": ["019b2a58-fef5-7d59-ae1c-46e4f0a13c73"]
  }
}
```

This materialization stores exact RFC 8785 canonical UTF-8 JSON for one
`did:web` document revision. The document's `id`, verification methods,
relationships and DIDComm services MUST match the named DID, key generations
and routes. `documentHash` is unpadded base64url SHA-256 of the blob bytes.

`previous` is the selected predecessor revision or null for the first
revision. Conflicting data under one revision ID is an integrity conflict.

#### `did.documentSelected`

```json
{
  "type": "did.documentSelected",
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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

## 6. Identity metadata, replicas, sync stores and extensions

### 6.1 `identity.label`

```json
{
  "type": "identity.label",
  "blobs": [],
  "data": {
    "name": "Alice"
  }
}
```

The latest value by canonical order is the user-visible identity name.
It is ordinary LWW metadata and has no key or protocol effect.

### 6.2 `replica.label`

```json
{
  "type": "replica.label",
  "blobs": [],
  "data": {
    "replica": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
    "name": "Phone"
  }
}
```

A label is encrypted vault metadata used to join a mediator's opaque
replica list with a human-readable UI. The latest label per replica by
canonical order wins. It is never sent to the mediator.

### 6.3 `replica.retired`

```json
{
  "type": "replica.retired",
  "blobs": [],
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

### 6.4 Sync-store events

#### `sync.configured`

```json
{
  "type": "sync.configured",
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
  "data": {
    "ext": "019b2a60-4f62-77af-b253-cb58278ade55",
    "name": "onion",
    "object": "bafy..."
  }
}
```

```json
{
  "type": "extension.removed",
  "blobs": [],
  "data": {
    "ext": "019b2a60-4f62-77af-b253-cb58278ade55"
  }
}
```

```json
{
  "type": "extension.purged",
  "blobs": [],
  "data": {
    "ext": "019b2a60-4f62-77af-b253-cb58278ade55"
  }
}
```

`installed` mints the extension-store ID. `object` is an optional name or
signed-package root understood by the host; it is not a blob reference
and therefore is absent from event `blobs`.

`removed` stops ordinary execution but preserves the extension store.
`purged` is terminal and requires every replica to dispose the extension
store and extension-local state. The lifecycle events remain in the main
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da"
  }
}
```

This is a permanent tombstone for one contact ID. Deleting a merged contact
appends one tombstone for every currently known member of the component. A
member learned later requires another tombstone.

## 8. Stored message document and message hashes

Message application content is kept in blob blocks. The body root of
`message.out` and `message.in` names RFC 8785 canonical UTF-8 JSON with this
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
      "root": "bafy..."
    }
  ]
}
```

Rules:

- `body` is the DIDComm application body object;
- `attachments` is ordered as in the logical application message;
- each descriptor's `root` is also listed in the event's
  `data.attachments` and envelope `blobs`;
- optional DIDComm attachment metadata may be retained as additional
  documented fields;
- attachment bytes are separate profile blobs;
- inline `data.base64` attachments are decoded before storage;
- inline `data.json` attachments are stored as RFC 8785 canonical JSON; and
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
  "please_ack": [],
  "ack": [],
  "headers": {}
}
```

`please_ack` is either null, meaning the header is absent, or an array,
meaning the header is present. A present empty array requests acknowledgment
of the current message. Non-empty elements name older messages to acknowledge
in addition to the current one. Version 3 forbids an empty-string sentinel and
forbids placing the current wire ID in this array.

For inbound normalization, absent `please_ack` is null, present empty
`please_ack` remains `[]`, and absent `ack` is `[]`. The arrays contain unique
strings and preserve wire order. In particular, `ack` follows oldest-to-newest
receive order and is never sorted lexicographically.

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

The stored application document is not required to preserve raw wire JSON.
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
  "blobs": ["bafy...body", "bafy...attachment"],
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
    "pleaseAck": [],
    "ack": [],
    "headers": {},
    "body": "bafy...body",
    "attachments": ["bafy...attachment"],
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

A contact target may select a rendezvous DID only when the message is an
initial message admitted by the rendezvous profile. Ordinary relationship
messages never select a rendezvous DID. A channel target is used for an
unattributed authenticated peer or a response pinned to one channel. A
peer-key-null channel cannot be used for an authenticated reply.

Requirements:

- `createdTime` is a durable UTC Epoch Seconds timestamp; a deterministic
  automatic effect may derive it from the triggering message;
- `expiresTime` is UTC Epoch Seconds or null and, when non-null, is strictly
  greater than `createdTime`;
- `pleaseAck` is null or an ordered array of unique non-empty message IDs;
- null `pleaseAck` means no header and submission-terminal completion;
- present `pleaseAck`, including `[]`, requests acknowledgment of the current
  message and selects receipt-required completion;
- a non-empty `pleaseAck` array names older messages in addition to the current
  message; it MUST NOT contain this message's wire ID;
- `ack` is an ordered array of unique non-empty message IDs in
  oldest-to-newest receive order;
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
- `blobs` is the distinct ordered set of `body` followed by `attachments`; and
- appending this event requires no network, resolver, mediator or socket.

A preparer MUST use the durable timestamp and exact headers. Version 3 emits
`typ`, `id`, `type`, `from`, `to`, `created_time` and `body`; emits `thid`,
`pthid` and `expires_time` when non-null; emits `please_ack` whenever
`pleaseAck` is not null, including an empty array; emits `ack` and
`attachments` when non-empty; and expands every `headers` entry at the
plaintext top level.

More than one `message.out` under one `mid` is allowed only when every field is
identical. Reuse of one wire ID with a different semantic or intent projection
is an integrity conflict.

### 9.3 `message.prepared`

```json
{
  "type": "message.prepared",
  "blobs": ["bafy...encrypted-envelope"],
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
    "envelope": "bafy...encrypted-envelope",
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
- the envelope blob contains exact normalized encrypted-message bytes;
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
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
  "blobs": ["bafy...body", "bafy...attachment"],
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
    "pleaseAck": [],
    "ack": [],
    "headers": {},
    "fromPrior": null,
    "body": "bafy...body",
    "attachments": ["bafy...attachment"],
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
  preserve normalized wire headers; absent `please_ack` is null, present empty
  `please_ack` remains `[]`, absent `ack` is `[]`, and no additional header is
  `{}`;
- acknowledgment arrays contain unique values and preserve exact wire order;
- `headers` contains every otherwise-unmodeled permitted top-level member and
  MUST NOT contain any reserved field, including `return_route`;
- `thid`, `pthid` and `signedBy` are present with null when absent;
- event `author` identifies the receiving replica;
- mediation and delivery ID are null for direct transport without them;
- `bytes` is the canonical retained document byte length; and
- `blobs` is the distinct ordered set of body followed by attachments.

A replica appends this event only after retained blobs are durable. Only then
may it ACK the mediator delivery. Ciphertext that cannot yet be decrypted or
mapped to locally available key material produces no `message.in` and no
pickup ACK; it remains a local deferred delivery and is retried after sync.

The rendezvous pre-vault admission exception is defined in
`rendezvous.md`: rejected, silently discarded or hard-rate-limited rendezvous
input MUST be pickup-ACKed without a `message.in` after safe classification.
That exception does not apply to ordinary accepted relationship traffic.

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

Message Pickup `messages-received` is local mediator state for one replica,
not a vault event. It follows durable `message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; every known local outbound wire ID in its validated `ack` array
may produce an idempotent `delivery.acknowledged`. A natural threaded response
without an explicit `ack` array does not acknowledge delivery.


## 11. Peer and profile observations

All events in this section carry a complete channel key. Peer DID evidence is
kept distinct from contact decisions and from our own DID entities.

### 11.1 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "blobs": ["bafy...resolved-did-document"],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "presentedDid": "did:web:alice.example",
    "did": "did:web:alice.example",
    "document": "bafy...resolved-did-document",
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
- `documentHash` is unpadded base64url SHA-256 of the blob bytes.
- the authenticated `peerKey` must be present under the named DID and exact
  document;
- `authenticationKids` and `keyAgreementKids` are context, not independent
  evidence that every listed key controlled the observed message; and
- `service` is the selected DIDComm service URI or null.

For an initial message to a rendezvous DID, this event is the
initial-message-bound resolution snapshot. A later `from_prior` is verified against this exact event and blob,
not an unrelated current web document. If the event or blob is temporarily
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
  "blobs": [],
  "data": {
    "scope": "relationship",
    "contact": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "from": "did:web:alice.example",
    "to": "did:peer:4zQm...alice-short",
    "presentedTo": "did:peer:4zQm...alice-short:z...alice-input-document",
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
- `from` is the prior canonical DID.
- `to` is the new canonical DID; for Peer DID numalgo 4 it is the short form.
- `presentedTo` is the exact newly disclosed DID and is REQUIRED to be the
  valid long form when that Peer DID is first seen.
- `priorResolution` names the exact `peer.resolved` event whose document and
  authentication method verify `fromPrior`.
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
Competing current ends are surfaced as a relationship conflict; canonical
time does not choose one. The compact JWT is evidence, not a blob reference.


### 11.3 `profile.nameClaimed`

```json
{
  "type": "profile.nameClaimed",
  "blobs": [],
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
  "blobs": [],
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
  "blobs": [],
  "data": {
    "id": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "keyGeneration": 0,
    "resolution": {
      "kind": "peer-long-form",
      "longForm": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
      "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos"
    },
    "authenticationKid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document#auth-0",
    "keyAgreementKid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document#agreement-0",
    "ingressRoutes": [
      "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
    ],
    "relationshipRoute": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "initialMessageTypes": [
      "https://didcomm.org/trust-ping/2.0/ping",
      "https://didcomm.org/basicmessage/2.0/message"
    ],
    "admissionPolicy": "ask",
    "maxInitialMessageLifetimeSeconds": 604800,
    "autoLimits": null
  }
}
```

The named DID has role `rendezvous`. `resolution.kind` is:

- `peer-long-form` for the REQUIRED default Peer DID profile; or
- `web-revision` for the OPTIONAL `did:web` profile.

For `peer-long-form`, `longForm` is the exact validated self-resolving Peer
DID, `documentHash` is the unpadded base64url SHA-256 of its RFC 8785 canonical
resolved DID document, and no `did.document*` event is involved. The
configured key IDs and the single ingress/relationship route MUST match the
long-form input document and the `did.created.boundRoute`.

A Web variant changes only the resolution object, for example:

```jsonc
{
  "kind": "web-revision",
  "documentRevision": "019b2a5b-5ab4-7c15-8b86-50650b78558d",
  "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos"
}
```

For a Web generation integer `N`, the selected DID URL fragments are
normative:

```text
<did:web>#authentication-N
<did:web>#key-agreement-N
```

They MUST resolve in the named document revision to the seed-derived keys for
`keyGeneration`.

Every generation freezes:

- the key-agreement method that decrypts new initial messages;
- the authentication method that signs initial-message-bound `from_prior`;
- exact initial-message-bound resolution evidence;
- non-empty ingress routes;
- the route encoded into a responder relationship DID;
- an exact non-empty initial-message type allowlist;
- maximum initial-message lifetime; and
- admission policy.

`admissionPolicy` is `ask`, `auto` or `silent`. `ask` is the default. `auto`
requires implementation-documented positive `autoLimits`; `ask` and `silent`
use null. A runtime may enforce stricter service or local limits.

The event is appended before remote exposure and does not alone make the
generation live:

- a Peer generation is live when its long form, decoded document, selected
  key IDs and bound route validate, and every selected mediated ingress route
  is currently reconciled; and
- a Web generation is live only when the exact selected document revision is
  observed published and every selected mediated ingress route is currently
  reconciled.

Before a reusable invitation or Web document is exposed, the runtime MUST
upload this event and every key/route/document dependency to each sync store
required by publication policy. A lagging replica then defers, rather than
ACKing, ciphertext for a configured generation it cannot yet use.

All overlapping generations for one Web rendezvous DID MUST name the same
`relationshipRoute`. A Peer rendezvous DID has one generation; changing keys
or route creates a new Peer DID and disclosure. One key generation maps to at
most one rendezvous generation. Different values under one generation ID are
an integrity conflict.

### 12.2 `rendezvous.generationRetired`

```json
{
  "type": "rendezvous.generationRetired",
  "blobs": [],
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
  "blobs": [],
  "data": {
    "inboundMid": "ca6f6a41-454c-53ff-b827-1797156687cf",
    "inboundWireId": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "inboundCreatedTime": 1788442800,
    "inboundExpiresTime": 1789047600,
    "initialMessageType": "https://didcomm.org/trust-ping/2.0/ping",
    "rendezvousDid": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "rendezvousDidValue": "did:web:alice.example",
    "generation": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "initiatorDid": "did:peer:4zQm...initiator-short",
    "initiatorLongForm": "did:peer:4zQm...initiator-short:z...initiator-input-document",
    "decision": "accept",
    "because": "user",
    "code": null,
    "relationship": "6ce7db61-5acf-54bd-a117-5fbc88fc3f71"
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
- reject requires `relationship == null` and a stable local code such as
  `not-accepted`, `capacity`, `policy`, `expired` or
  `sender-did-conflict`.
- ignore requires both `code` and `relationship` null.

The event `at` is parsed as an RFC 3339 instant. An accept is timely only when:

```text
parseRFC3339(event.at) < UnixEpoch + inboundExpiresTime seconds
```

Equality is expired. A candidate reaching expiry before acceptance may only
receive a new reject or ignore decision.

Before a response intent exists, equal observations are duplicates, one valid
user decision outranks policy observations, contradictory user decisions are
a visible conflict, and otherwise incompatible policy decisions remain a
visible conflict.

Once a natural response, Trust Ping response or Empty ACK intent has been
committed for this candidate, later rejection cannot retroactively undo the
relationship. Ending it uses normal contact deletion and DID/route retirement.

The decision does not prescribe a wire message. Rejection may be silent or may
produce a protocol-specific error or Report Problem 2.0 message. Acceptance uses standard Trust Ping, an already-due and safe natural
application response, or Empty Message as defined by `rendezvous.md`. The
relationship decision does not decide the application protocol's business
outcome.

Reuse of one `peerKey` under another canonical `initiatorDid` for the same
stable relationship is a sender-DID conflict and cannot rewrite the remote
DID.

### 12.4 `relationship.established`

```json
{
  "type": "relationship.established",
  "blobs": [],
  "data": {
    "id": "6ce7db61-5acf-54bd-a117-5fbc88fc3f71",
    "contact": "f8a38c56-25b0-54d9-8be7-669cc46b3906",
    "rendezvousDid": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "rendezvousDidValue": "did:web:alice.example",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "ourDid": "6ff509cd-e2b0-53ff-be69-8a35eccf4ad3",
    "route": "019b2a58-75ab-7880-a7d2-c677b6b3bfd1"
  }
}
```

This is stable responder relationship state for
`(rendezvousDidValue, peerKey)`. Different initial message IDs or protocol
types from the same authenticated initiator key reuse the same event, contact,
responder relationship DID and route while remaining separate application
messages with separate automatic effects.

The stable event deliberately omits an origin message, generation and remote
DID. Those values are derived from effective accepted
`relationship.admissionDecided` events. The canonical origin is the earliest
valid accepted candidate by:

```text
(inboundCreatedTime, inboundWireId, generation)
```

after user-over-policy precedence.

The IDs equal the deterministic derivations in `rendezvous.md`. `ourDid` names
the responder relationship DID and `route` its bound route. Every overlapping
rendezvous generation capable of creating the relationship must name the same
relationship route.

The relationship, deterministic contact, channel attachments,
`contact.useDid`, responder `did.created` and selected protocol response
`message.out` SHOULD be appended in one batch after effective acceptance.
Equal stable statements from several replicas are duplicates. Different
values under one relationship ID are an integrity conflict.

If effective accepted candidates contain more than one canonical initiator DID
for one `peerKey`, the relationship has a sender-DID conflict and no ordinary
current remote end.

The responder repeats one byte-stable `from_prior` on every package from
`ourDid` until it receives an authenticated message addressed to `ourDid`.
Receipt-required response retry ends only after explicit ACK or another
terminal state.

## 13. Automatic effects

An inbound logical message may be observed by several replicas. An
automatic handler computes:

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

The same logical input and handler action MUST produce the same
`effectId`. A protocol MAY define a stricter effect scope. The rendezvous
profile derives stable relationship state from `(rendezvous DID, peer key)`,
while each actual application response is an ordinary effect of its triggering
inbound message.

- Automatic contacts use the deterministic contact rule in section 7.
- Automatic outbound messages derive stable `mid` and `wireId` values in
  section 9.
- Handler-produced events SHOULD include `effectId` when their schema
  permits diagnostics and duplicate recognition.
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

Every rendezvous handoff response freezes:

```text
createdTime = triggering message.createdTime
expiresTime = triggering message.expiresTime + 604800
fromPrior.iat = createdTime
```

The addition fails closed on integer overflow. Acceptance still must be
committed before the triggering message expires.

There is no distributed exactly-once claim. A generic effect lease may
reduce duplicate work but MUST NOT be required for correctness.

## 14. Folds

All folds accept events in any order and are deterministic over the set.
Canonical order is used only where stated.

### 14.1 Replica fold

For each replica ID seen as an author, label target or retirement target:

- `label` is the latest `replica.label` by canonical order;
- `retired` is true if any `replica.retired` names it;
- `firstEventAt` is the earliest accepted event authored by it; and
- `lastEventAt` is the latest accepted event authored by it.

Retirement does not mark later events suspect or invalid. The fold may show
them for diagnostics because delayed sync and a hostile holder of the shared
seed are indistinguishable at this layer.

Mediator-reported active registration is live remote state and is joined by
the runtime, not recorded as authority in this fold.

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

Every full replica attempts replica registration and pickup on every
reachable mediation in this set. The web publisher and a server full replica
receive no special ownership.

### 14.3 Sync-store fold

For each sync configuration ID:

- exactly one consistent `sync.configured` defines its store DID;
- any `sync.retired` makes the configuration terminal; and
- conflicting configuration values make it unusable and visible as a
  conflict.

The preferred sync store is the latest `sync.selected` target that is
configured, non-retired and non-conflicted. If no preferred store is usable,
local commits continue and sync is offline. A runtime MAY also mirror to
other usable configurations, but failure of one store MUST NOT block another.

Remote `store_id`, server sequence cursors, upload tickets and endpoint
caches are local state. They never enter this fold.

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
- document hash and blob bytes agree.

A single route may be selected by many DIDs. This is transport reuse, not DID
or contact equivalence.

The desired mediator recipient set contains each `(DID string, mediated
route)` pair required by a live DID, selected document or rendezvous
generation. `did.routeRegistered` and `did.routeUnregistered` are audit
observations only; the runtime queries each mediator and reconciles desired
state with a recipient-control proof.

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
  keys and bound route, and every selected mediated ingress route is currently
  reconciled;
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

For one candidate before a response intent exists:

1. equal decisions are duplicates;
2. one valid user decision outranks policy observations;
3. contradictory user outcomes are a visible conflict;
4. a timely policy accept outranks a later policy reject with code `expired`;
   and
5. otherwise incompatible policy outcomes remain visible conflicts.

A committed natural response, Trust Ping response or Empty ACK intent seals
that candidate's acceptance for protocol output. Later rejection cannot undo
already materialized relationship state. Rejection never creates a custom rendezvous decline.

Group `relationship.established` by deterministic relationship ID. Equal
stable values are one relationship. The identity is derived from rendezvous
DID and authenticated initiator key, not initial wire ID or protocol type.
Different stable values are an integrity conflict.

For each non-conflicted relationship, collect effective accepted candidates
and order them by:

```text
(inboundCreatedTime, inboundWireId, generation)
```

The earliest derives `originInbound`, `originGeneration`, `theirDid` and
`theirLongForm`. If accepted candidates present more than one canonical
initiator DID for the same peer key, the relationship has a sender-DID conflict
and no ordinary current remote end.

A valid relationship contributes:

- one deterministic contact;
- authenticated bootstrap channels;
- the pairwise relationship channel;
- one local relationship DID and route;
- one canonical remote Peer DID; and
- zero or more ordinary protocol response effects.

The relationship's pairwise route is confirmed when an authenticated message
is received at the responder relationship DID. Until then, every package from
that DID to the contact carries the same verified `from_prior`. An explicit
ACK naming a receipt-required handoff response controls delivery retry; a
message merely addressed to the new DID confirms rotation but does not invent
an ACK.

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
- erasure is applied before blob presence; and
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
  `fromPrior` only under the validated repack rules in sections 8–9 and
  `distributed-delivery/1.0`;
- one package is inactive after `message.packageRetired` or a package-scoped
  non-retryable failure;
- unresolved holds are exact `delivery.held` events not named by
  `delivery.released`;
- `receiptRequired` is true exactly when `message.out.pleaseAck` is not null;
- `acknowledged` is true if a valid authenticated inbound `ack` names the
  wire ID on an allowed contact-scoped continuation and all
  protocol-specific proof gates have passed;
- `submitted` is true if any package has `delivery.submitted`;
- a message-scoped non-retryable failure, including expiry, permanently ends
  new automatic preparation/submission for that intent;
- for `receiptRequired == false`, the first successful submission also ends
  automatic background retry;
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

This resolves the expiry/ACK case without contradiction: expiry is an
irreversible no-more-work boundary, while later authenticated evidence may
still improve the recorded outcome from expired to acknowledged-late.

Any full replica may process a valid queued or retryable message. Authorship
never limits outbox ownership. Import or synchronization does not create a
hold. When a durable expiry has passed, every replica converges on no further
preparation or submission even if only one has yet appended the terminal
failure observation.

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
  "blobs": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "drop": ["bafy...body", "bafy...attachment"],
    "because": "user"
  }
}
```

`because` is `user`, `contact-deleted` or another stable policy code.
`drop` contains roots named by one or more events for the message.
They are names to release and therefore MUST NOT appear in the erase
event's `blobs`.

Erasure is global and permanent for that message/root relation. Blob
bytes may remain because another message or event retains the same root.
The erased message still reads erased.

### 15.2 Reading content

For a message root:

1. if any `message.erased` for the message names the root, state is
   **erased** regardless of block presence;
2. otherwise, if every required block is present, content is available;
3. otherwise, if the message or object type explicitly permits partial
   trees, state may be **not yet fetched**; and
4. otherwise state is **missing or damaged**.

Missing bytes MUST NOT be displayed as intentional deletion.

### 15.3 Held roots

The application computes the roots passed to `BlobStore.collect`.

A root is held when at least one accepted event retains it through
`event.blobs`, except:

- a root dropped by `message.erased` is not held by that message;
- a `message.prepared` envelope is not held after its package is retired;
- all prepared-envelope roots for a message cease to be held after the
  message is acknowledged, unless another event independently retains
  them; and
- an extension store computes its held roots from its own event set.

Unknown event types retain every root in their `blobs` for the life of
the event set because version 3 defines no erase rule for them.

A block may be collected only when no held root reaches it and the
backend's orphan grace has elapsed.

### 15.4 No replica-local eviction event

Version 3 does not represent local body eviction as a portable event.
A local storage policy that deletes a non-erased retained block makes the
copy incomplete; `vault-sync/1.0` or another replica may restore it.
Such a local absence never authorizes another replica to collect bytes.

## 16. Procedures

These procedures define required ordering. Implementations may combine steps
transactionally but may not reverse the durability boundaries.

### 16.1 Open a writable full replica

1. verify folder/store version and anchor;
2. unlock or obtain the seed;
3. load or mint local `replica_id` and store generation;
4. fold extension lifecycle and dispose purged stores;
5. fold configured sync stores and reconcile each reachable usable store;
6. refold portable state;
7. if this replica is retired, mint a new local replica context;
8. derive every required mediation account;
9. register this replica and reconcile every required mediated route;
10. drain per-replica pickup queues;
11. reconcile selected `did:web` document revisions when this runtime has
    publication authority; and
12. start live delivery, periodic sync, publication and retry workers
    independently.

Failure of one mediator, sync store or web publisher MUST NOT prevent local
vault use or already established pairwise communication through another
route.

A server holding the seed follows exactly this procedure and is an ordinary
full replica. A remote thin client without the seed does not.

### 16.2 Establish mediation

1. append `mediation.created` before the network request;
2. derive its shared account key;
3. perform Coordinate Mediation;
4. on grant, append `mediation.granted`;
5. register the local replica through `replica-mediation/1.0`; and
6. append `mediation.selected` when policy chooses it for new mediated
   routes.

A network failure after step 1 leaves a retryable intent, not a half
identity.

### 16.3 Configure a sync store

1. mint a configuration ID and append `sync.configured` before required
   network work;
2. resolve the store DID and establish the shared sync account;
3. run `vault-sync/1.0` hello and full inventory;
4. publish missing root, blocks and events; and
5. append `sync.selected` when policy chooses it as preferred.

A failed store remains configured and retryable until explicitly retired.
Folder restore can discover it from the event set; seed-only bootstrap still
requires an external locator for first contact.

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
5. upload events and dependencies to every sync store required by disclosure
   policy;
6. register the canonical short form on every mediated ingress route and
   append `did.routeRegistered`; and
7. append `did.disclosed`, exposing only the rendezvous Peer DID long form in
   an OOB invitation, QR, file or another discovery object.

The Peer generation is live after local long-form validation and current route
reconciliation. A lagging replica that cannot map the recipient key leaves the
mediator delivery unacknowledged until sync/refold completes.

The optional Web facade instead:

1. chooses a `did:web` string under a controlled domain/path;
2. derives keys and appends the Web `did.created` entity;
3. configures/selects routes;
4. stores exact canonical `did.json`, then appends
   `did.documentPrepared`, `did.documentSelected` and
   `rendezvous.generationConfigured` with `resolution.kind ==
   "web-revision"`;
5. sync-publishes portable dependencies;
6. publishes and fetch-verifies the document;
7. reconciles mediated recipient registration;
8. appends `did.documentPublished` after verification; and
9. optionally appends `did.disclosed` for a reusable URL, OOB invitation or
   directory profile.

The Web generation is live only after selected revision and all mediated
registrations verify. In both profiles the rendezvous DID belongs to the
vault, not the process displaying the invitation or serving `did.json`.

### 16.6 Send an initial message

1. learn a rendezvous DID through OOB, QR, directory, file or manual input;
2. create/select a contact and append `contact.peerDidAdded` for that DID;
3. create one local relationship `did:peer:4`, retain both forms and associate
   it with the contact;
4. select an exact initial message type allowed by the rendezvous profile;
   when no application content exists, use Trust Ping 2.0 `ping` with
   `response_requested == true`;
5. write body/attachments and append `message.out` with finite expiry,
   `pleaseAck == []`, OOB invitation ID as `pthid` when applicable, and all
   hashes; this may happen offline;
6. after intent exists, register the initiator relationship DID canonical
   short form on selected mediated routes;
7. resolve the rendezvous DID and append exact `peer.resolved` evidence;
8. append `channel.firstSeen` and `contact.attached` for the bootstrap channel
   with `because == "rendezvous"`;
9. prepare using initiator Peer DID long form in plaintext `from`, protected
   `skid` and decoded `apu`; and
10. submit against the pinned generation and retry until explicit ACK, expiry
    or hold.

The first message is the real Trust Ping or application message. It is not
wrapped in a custom rendezvous message.

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
   capable of becoming live, retain the delivery unacknowledged, record only
   bounded local deferred state, sync/refold and retry;
3. after authenticated decryption, run `rendezvous.md`'s hard pre-vault gate
   before `message.in`;
4. safely classified hard rejection MUST be pickup-ACKed and leaves no
   portable message/contact/relationship state;
5. for an admitted candidate, store retained bytes, append `message.in`, then
   ACK this replica's mediator delivery;
6. append or await `relationship.admissionDecided` according to `ask`, `auto`
   or local policy; and
7. do not materialize a relationship while the effective decision is
   conflicted.

An accept is valid only when the decision event instant is strictly before the
candidate's Epoch-Seconds expiry. Equality is expired. After expiry, a new
decision can only reject or ignore.

For effective reject or ignore, create no relationship DID. Rejection may be
silent or may produce a protocol-specific error or Report Problem 2.0 intent,
which is appended before any resolution, preparation or submission.

For effective accept:

1. derive stable relationship, contact and local pairwise DID IDs from
   rendezvous DID and authenticated initiator key;
2. reject acceptance when the deterministic contact is tombstoned or the same
   key presents another canonical initiator DID;
3. derive/reuse the responder relationship DID and common relationship route;
4. choose the handoff response: Trust Ping `ping-response`; an already-due
   and safe natural application response; or otherwise an Empty Message ACK;
5. append, preferably in one batch, the admission decision, any new
   `contact.created`, bootstrap/pairwise `contact.attached`, `did.created`,
   `contact.useDid`, `relationship.established`, and deterministic response
   `message.out`;
6. response intent explicitly ACKs the initial wire ID, has
   `pleaseAck == []`, uses the deterministic handoff timestamps in section 13,
   and is sent from the responder relationship DID with initial-message-bound
   `from_prior`;
7. only after the durable batch, register the responder pairwise DID canonical
   short form;
8. prepare with long-form first-disclosure sender evidence; and
9. submit and retry until explicit ACK, expiry or hold.

Repeated initial messages for the same stable initiator key reuse the
relationship but remain separate application messages with separate ordinary
automatic effects.

Until an authenticated message arrives at the responder pairwise DID, every
outbound package from that DID to the contact carries the same byte-stable
`from_prior`. Ordinary messages may therefore be prepared without becoming
unattributed even if they overtake the selected response, though the runtime
SHOULD prioritize the response.

### 16.8 Send an ordinary message

The synchronous full-vault send operation:

1. writes attachment blocks;
2. writes the stored message document;
3. selects durable `createdTime`, optional `expiresTime`, exact `pleaseAck`
   value (null or array), exact ordered `ack`, and a complete `headers` map;
4. computes semantic and intent hashes;
5. rejects a rendezvous DID as an ordinary relationship target;
6. appends `message.out`; and
7. returns `mid` and `wireId`.

It performs no network operation. `pleaseAck != null`, including `[]`, selects
receipt-required completion. Null selects submission-terminal completion.

Any replica may later:

1. stop when held, acknowledged, terminally failed, expired, or
   submission-terminal and already submitted;
2. fold target contact/channel;
3. choose valid sender DID, peer DID/key and exact resolution evidence;
4. attach the stable contact-scoped `from_prior` while the selected pairwise
   transition remains unconfirmed;
5. construct complete plaintext by copying every intent-time header;
6. compute plaintext hash, encrypt, store exact envelope and append
   `message.prepared`;
7. submit directly or through Routing 2.0 with `packageId == forward.id`;
8. append submitted or failed observation; and
9. retry according to completion mode.

A new package may change address/security evidence only under validated
repack rules while preserving semantic and intent hashes. Receiving may join
equal wire IDs across a verified peer-key transition in one contact.

### 16.9 Receive a message

For every pickup or direct delivery:

1. if the ultimate key is locally unknown, or belongs to a configured
   rendezvous generation that may become live but is not live, keep the
   delivery pending, sync/refold and retry without pickup ACK;
2. authenticate, decrypt and validate complete innermost message, including
   Peer DID long-form and authcrypt sender evidence;
3. when addressed to a rendezvous DID, run section 16.7's bounded pre-vault
   gate; safely classified rejection MUST be pickup-ACKed without
   `message.in`;
4. for admitted or ordinary traffic, derive channel, observation MID,
   semantic hash, intent hash and exact plaintext hash;
5. write retained body and attachment blocks and stored message document;
6. append `message.in` durably with applicable `channel.firstSeen`, exact
   `peer.resolved`, contact attachment and non-controversial lifted
   observations;
7. only then ACK this replica's mediator delivery;
8. before processing ACK values or continuation, validate every package-level
   proof; for an unknown DID carrying `from_prior`, validate it against exact
   pinned historical evidence first;
9. after successful validation, append `peer.transitioned` when applicable
   and process explicit `ack` values into idempotent
   `delivery.acknowledged`;
10. schedule deterministic application effects or
    `relationship.admissionDecided`;
11. when `pleaseAck` is present, create or reuse the natural response or
    pure-ACK effect; and
12. on duplicate receipt, re-submit the same already-prepared response package
    rather than creating another effect or package.

Steps 5–6 SHOULD use one atomic batch. A backend without atomic batch appends
`message.in` first; no lifted observation is sole evidence for an uncommitted
message.

A conforming pure ACK is retained for audit and delivery processing but
excluded from user threads, unread counts, notifications and application
handlers. It has `pleaseAck == null`, so first successful submission ends
normal retry. Duplicate delivery of the message it acknowledges may still
trigger re-submission of that exact ACK package.

A crash before durable message commit leaves mediator delivery pending. A
crash after commit but before pickup ACK causes redelivery and another valid
duplicate observation.

### 16.10 Retire or re-incarnate a replica

To retire another replica deliberately:

1. append `replica.retired` for the target with a stable `because` value;
2. synchronize the event;
3. every active replica reconciles retirement to every shared mediation
   account; and
4. labels and historical events remain.

When a running local copy learns from any required mediator that its own
current replica ID was terminally retired—for example by an advertised
inactivity policy—it MUST perform one local re-incarnation:

1. pause new appends, pickup ACKs, live delivery and outbound submission;
2. finish or safely checkpoint local durable writes; old-author events remain
   ordinary sync objects;
3. atomically replace both `replica_id` and `store_generation` in
   `local/replica.json` with fresh UUIDv7 values;
4. reopen every local event store with the new author and invalidate all local
   change tokens/caches tied to the old store generation;
5. append `replica.retired` naming the old ID with
   `because == "inactivity-policy"` unless equivalent portable state already
   exists;
6. register the new ID on every required mediation, requesting retained
   replay, then reconcile the old ID as retired on the remaining mediators;
7. resume sync, pickup and outbound work only under the new ID.

A single mediator's terminal response rotates the local replica ID globally;
a runtime MUST NOT use one author/ACK identity on some mediators and another
on others. This procedure does not secure a stolen seed. Security recovery
requires root or communication-key rotation outside
`replica-mediation/1.0`.

### 16.11 Erase a message

1. fold every root currently retained by the logical message and its prepared
   packages;
2. append one or more `message.erased` events naming the requested roots;
3. refold held roots; and
4. call blob collection.

Late duplicate observations may introduce another event retaining the same
logical roots. A replica that observes an existing erase MUST append an
equivalent erase for newly learned roots of that message before those roots
are considered intentionally released.

### 16.12 Delete a contact

1. append `contact.deleted` for every currently known member of the contact
   component, preferably through `appendAll`;
2. for every message exactly attributed to the component, append erases for
   body, attachment and prepared-envelope roots required by policy;
3. retire relationship DIDs exclusively associated with the deleted
   component;
4. retire or unregister their routes;
5. preserve a shared rendezvous DID unless separately retired; and
6. collect unheld blocks after grace.

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

### 17.2 Blob merge

After event union, copy only valid absent blocks reachable from roots held
by the merged fold. An erased relation does not revive merely because an
older source still has the bytes.

Missing non-erased bytes remain an integrity/availability condition and
may be repaired from another replica or `vault-sync/1.0`.

### 17.3 Replica synchronization

`vault-sync/1.0` exchanges encrypted immutable root, event and block
objects. Rendezvous DID entities, optional selected Web document revisions, relationship DIDs
and scoped transitions are ordinary encrypted events and blobs; the sync
store receives no special web role metadata. It does not synchronize:

- local replica selection;
- mediator pickup acknowledgments;
- local holds or retries unless they are vault events;
- caches, trace or sockets; or
- human-readable folder paths.

Push lowers latency. Full inventory anti-entropy provides correctness.

### 17.4 Restore

A portable folder restore or sync bootstrap creates a new local replica
ID. The restored copy may derive every mediation and communication key,
register itself with each required mediator, replay retained mailbox
messages and continue every non-held, non-acknowledged outbound message.

If the restored runtime also receives deployment authority for a selected
optional `did:web` rendezvous facade, it may reconcile and publish the same document revision. This does
not make it the owner of the rendezvous DID in vault semantics. A restored full
replica without publication authority can still use every established
pairwise relationship and mediated route.

No old replica must be online. Mediator retention still bounds messages that
were never committed to any vault replica.

### 17.5 Forked author

If two writable copies accidentally preserve the same local replica ID,
previously unseen same-author events cause `ForkedAuthor`. One copy mints
a new local replica ID and retries merge. Existing events under the old
author remain unchanged.

## 18. Privacy and security boundaries

- All full replicas share one seed and equal communication authority.
- A full replica may run locally or on a server; process location does not
  confer ownership of a DID.
- Replica IDs and event authors are operational labels, not credentials or
  peer-visible addresses.
- Retiring a replica does not revoke an extracted seed.
- The readable folder contains plaintext retained message content and
  attachments unless surrounding storage encrypts it.
- A rendezvous DID is intentionally disclosed and correlatable within its
  audience. A Peer profile avoids DNS resolution; an optional Web profile also
  exposes DNS, publisher and resolver metadata.
- A relationship DID SHOULD be disclosed only through encrypted interaction
  and MUST NOT appear in a reusable public invitation or rendezvous DID document.
- A valid rendezvous-to-pairwise `from_prior` is stored only as contact-scoped
  evidence. It MUST NOT globally link pairwise relationships created for
  different contacts.
- `replica-mediation/1.0` stores only encrypted inner DIDComm envelopes and
  routing/delivery metadata at the mediator.
- `vault-sync/1.0` stores client-side encrypted opaque objects and does not
  receive event types, CIDs, DID roles or author IDs in plaintext.
- The mediator may observe the mediation account, recipient DID and therefore
  its method, ciphertext size, replica ID, arrival, pickup, ACK, expiry, IP
  and traffic timing. It is not sent a contact ID or relationship ID.
- A direct endpoint sees transport metadata and encrypted DIDComm envelopes;
  it is not an application-level replica address.
- Ultimate ACKs reveal durable-receipt timing to the peer but not which
  replica received first.
- Ordinary `did:web` publication depends on DNS, HTTPS and deployment
  authorization. Vault events preserve desired and observed revisions but do
  not provide an append-only rendezvous DID history.
- Event authorship does not authenticate one full replica against another
  malicious holder of the seed.

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

1. Every local event has `author == local replica_id`.
2. A server full replica has the same event and pickup semantics as a local
   full replica; a thin client without seed is not an author.
3. Mediation and communication keys created by one replica are derivable by
   another full replica.
4. Replica retirement changes delivery policy but does not invalidate events
   or revoke the shared seed.
5. Mediator-reported terminal retirement causes atomic replacement of local
   `replica_id` and `store_generation`; old-author events remain valid.
6. A send commits body, attachments and `message.out` with networking disabled.
7. `message.out` freezes created time, expiry, nullable `pleaseAck`, ordered
   `ack` and every permitted additional header.
8. Null `pleaseAck` means no wire header and submission-terminal completion;
   present `[]` emits an empty `please_ack` header and requests receipt.
9. Empty-string `please_ack` sentinels and current wire ID inside the array are
   rejected.
10. `return_route` is rejected in vault application headers.
11. Semantic hash covers application ID/type/thread/body/ordered attachments;
    intent hash additionally covers immutable control headers; plaintext hash
    covers one exact DIDComm plaintext.
12. Two packages may differ in valid address/security evidence while agreeing
    on wire ID, semantic hash and intent hash.
13. Retrying one package preserves identical plaintext, envelope and package
    ID.
14. HTTP success produces `delivery.submitted`, never acknowledgment.
15. A natural response acknowledges an outbound only when authenticated
    explicit `ack` names its wire ID.
16. Expiry irreversibly ends work; later valid evidence may display
    acknowledged-late without restarting it.
17. Equal authenticated variants derive one observation MID. Equal wire IDs
    under transition-verified peer keys in one contact merge only at the
    logical-message layer.
18. Semantic/intent conflicts suppress disputed automatic effects and ACK
    processing.
19. Pure Empty ACK is retained and processed but excluded from threads,
    unread counts, notifications and application handlers.
20. Pure ACK has `pleaseAck == null`; its first successful submission is
    terminal and creates no ACK loop.
21. Duplicate receipt of a message with present `please_ack` re-submits the
    same prepared response/ACK package.
22. Pickup ACK follows durable message/blob commit for admitted traffic.
23. Ciphertext for an unknown or configured-but-not-live rendezvous generation
    remains unacknowledged and is retried after sync/fold changes.
24. Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.
25. `peer.resolved` retains exact canonical document bytes/hash,
    presented/canonical DID forms and selected key IDs.
26. Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
27. A reusable invitation contains a rendezvous DID and no relationship DID;
    the default Peer path requires no DNS or Web DID.
28. A Peer generation becomes live from validated long-form state and route
    reconciliation; a Web generation additionally requires exact publication.
29. `initialMessageTypes` is exact and non-empty; Trust Ping `ping` is
    supported by every implementation.
30. The first bootstrap message is an ordinary allowlisted protocol message,
    not an Estoc rendezvous wrapper.
31. `relationship.admissionDecided` records a local accept/reject/ignore
    decision and does not prescribe a wire response type.
32. Two initial wire IDs from the same `(rendezvous DID, initiator key)` derive
    one relationship/contact/responder DID and remain separate messages.
33. A deterministic contact tombstone is not resurrected; reconnect requires a
    fresh initiator relationship key.
34. Event `at` is parsed as RFC 3339 and compared with Epoch-Seconds expiry as
    an instant; equality is expired.
35. Only effective acceptance may materialize pairwise relationship state.
36. A later rejection cannot reverse an already committed handoff response;
    ending the relationship uses contact deletion and DID/route retirement.
37. Reuse of one initiator key under another canonical Peer DID is a
    sender-DID conflict.
38. Stable `relationship.established` omits race-selected origin fields; fold
    derives origin from the earliest effective accepted candidate.
39. Response intent precedes pairwise recipient registration, and registration
    precedes submission.
40. Trust Ping is the default no-content initial message; an allowlisted
    application message may be first without wrapping.
41. The first response is a natural protocol response, Trust Ping
    `ping-response`, or Empty Message ACK.
42. A handoff response carries explicit ACK, present `pleaseAck == []`,
    long-form responder Peer DID and verified initial-message-bound `from_prior`.
43. `peer.transitioned` verifies `from_prior` before applying response ACK.
44. Until an authenticated message arrives at the responder pairwise DID,
    every package from it carries the same byte-stable `from_prior`.
45. A rejected bootstrap emits no custom decline; optional explicit rejection
    uses a normal protocol error or Report Problem 2.0.
46. A rendezvous DID is excluded from ordinary `writeTo`; initial-message
    procedure is the only ordinary sender path targeting it.
47. Contact-scoped transition does not globally retire or union the rendezvous
    DID with unrelated relationships.
48. Peer/Web rendezvous and relationship DIDs may reuse one mediated route and
    retain per-replica ACK isolation.
49. `did.routeRegistered` and `did.documentPublished` are observations that
    reconnect must revalidate.
50. Established pairwise traffic remains usable when an optional Web publisher
    is unavailable.
51. Erasure is checked before block presence; late roots receive equivalent
    erasure closure.
52. Restore without `local/` creates a new replica that resumes mediation,
    pickup, sync, publication reconciliation and eligible outbox work.
53. Shuffling the same event set leaves every fold result unchanged.
