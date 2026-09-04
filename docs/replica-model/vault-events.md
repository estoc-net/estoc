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
the DID before using the vault. The anchor remains independent of public or
relationship communication DIDs. In particular, a `did:web` rendezvous DID
MUST NOT replace the anchor merely because a web service hosts a full
replica.

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

A version-3 `did:peer:4` relationship DID has generation `0`; changing its
keys or embedded service creates another DID and a scoped transition. A
`did:web` rendezvous DID may add later key generations while its DID string
remains unchanged.

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

### 3.4 Entity IDs

Unless a rule below says deterministic, locally created entity IDs are
canonical UUIDv7.

The following fixed UUIDv5 namespaces are used for cross-replica
idempotency:

```text
inbound message:       689dff5c-d975-5725-898f-267e97e909c1
automatic contact:     b1942994-48f8-58ff-9117-0df20f60c150
automatic MID:         3e4f042b-9cb7-568c-a065-59c7c0d2f5ba
automatic wire ID:     1bbea408-beff-5583-b67b-5b51393b7e51
rendezvous relationship: cfb3704a-cae5-56f9-a3e6-d73cf8246646
rendezvous local DID:    50386028-0062-554d-9f0a-a5a21d300b56
rendezvous contact:      da33b3a9-0360-5acf-a089-3ceb1fd2ee6b
```

A UUIDv5 name is the UTF-8 RFC 8785 canonical encoding of the JSON array
specified by the rule. This gives unambiguous nulls and field boundaries.

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
rendezvous    public reusable discovery, profiled as did:web
relationship  pairwise ongoing communication, profiled as did:peer:4
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

```json
{
  "type": "did.created",
  "blobs": [],
  "data": {
    "id": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "did": "did:web:alice.example",
    "longForm": null,
    "method": "web",
    "role": "rendezvous",
    "generation": 0,
    "authenticationKeys": [
      "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/authentication/0"
    ],
    "keyAgreementKeys": [
      "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0"
    ],
    "boundRoute": null
  }
}
```

`method` is `web` or `peer`; `role` is `rendezvous` or `relationship`.
Version 3 permits the pairs `(web, rendezvous)` and `(peer, relationship)`.
Other pairs require a compatible extension or a later vault version.

Generation `0` is created with the DID. `authenticationKeys` and
`keyAgreementKeys` each contain exactly one name in version 3. Every key name
MUST use the event's DID entity ID and generation. The seed-derived public
keys MUST match the DID or the prepared DID document.

For a relationship `did:peer:4`, `did` is the canonical short form,
`longForm` is the corresponding self-resolving long form and `boundRoute` is
REQUIRED and names the route encoded into the input document. The long form
MUST be used on first disclosure; the short form is used for subsequent
vault references and mediator registration. For a rendezvous `did:web`,
`longForm` is null and `boundRoute` is null because selected document
revisions may advertise one or more routes.

A deterministic rendezvous handler may use a UUIDv5 `id`; ordinary creation
uses UUIDv7. Repeating one ID with different identity fields is an integrity
conflict.

A relationship variant has this shape:

```jsonc
{
  "id": "4275e88e-2a9d-5b5f-8346-f17ef35b71c5",
  "did": "did:peer:4zQm...short",
  "longForm": "did:peer:4zQm...short:z...input-document",
  "method": "peer",
  "role": "relationship",
  "generation": 0,
  "authenticationKeys": ["did/4275e88e-2a9d-5b5f-8346-f17ef35b71c5/authentication/0"],
  "keyAgreementKeys": ["did/4275e88e-2a9d-5b5f-8346-f17ef35b71c5/key-agreement/0"],
  "boundRoute": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
}
```

#### `did.keyGenerationAdded`

```json
{
  "type": "did.keyGenerationAdded",
  "blobs": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "generation": 1,
    "authenticationKeys": [
      "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/authentication/1"
    ],
    "keyAgreementKeys": [
      "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/1"
    ]
  }
}
```

Only a non-retired `did:web` may add generations in version 3. A generation
number and every key name are immutable. The fold reports conflicting values
rather than choosing one.

Adding a generation does not publish or select it and does not remove older
keys from a document.

#### `did.keyGenerationSelected`

```json
{
  "type": "did.keyGenerationSelected",
  "blobs": [],
  "data": {
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "generation": 1
  }
}
```

The latest valid selection by canonical order is preferred for new outbound
cryptographic use and newly prepared web document revisions. Generation `0`
is selected when no explicit selection exists.

Selection does not delete the private keys or invalidate a previously
published revision. Receive and verification eligibility is determined by
selected documents, routes and rendezvous-generation policy.

### 5.3 Delivery routes

A route is a reusable, vault-scoped transport configuration. It does not
belong to a replica or a single communication DID. One public DID and many
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

For a relationship `did:peer:4`, the list MUST contain exactly its
`boundRoute`; changing that route creates another relationship DID and a
contact-scoped transition. A rendezvous `did:web` may publish several routes
while its DID string remains unchanged.

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
verified recipient registration. A reusable public invitation SHOULD expose
a rendezvous DID and MUST NOT expose a relationship DID.

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
selects exactly one key-agreement generation for new requests. Older
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
    "because": "lost"
  }
}
```

Retirement is a terminal desired-delivery policy:

- active replicas reconcile it to each shared mediation account;
- the mediator stops creating future deliveries for the replica;
- events already authored by it remain valid; and
- it does not revoke the seed or prevent a holder from registering a new
  replica ID.

A local client that discovers its current replica ID retired MUST stop
using that ID and mint a new local replica context before further writes
or pickup.

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
`contact.merged` edges. It may hold an unverified public DID before any
authenticated channel exists and later move to a pairwise DID within the same
relationship context.

### 7.1 Contact IDs

A user-created contact uses a UUIDv7 `cid`.

An automatic handler adopting an ordinary authenticated channel uses:

```text
cid = UUIDv5(
  b1942994-48f8-58ff-9117-0df20f60c150,
  RFC8785(["v1", myKey, peerKey])
)
```

A responder accepting one `rendezvous/1.0` request instead uses:

```text
cid = UUIDv5(
  da33b3a9-0360-5acf-a089-3ceb1fd2ee6b,
  RFC8785(["v1", relationship_id])
)
```

`relationship_id` is the deterministic value from `rendezvous/1.0` over the
exact public DID and authenticated initiator key. It deliberately excludes
request wire ID. Retries and replacement requests from the same initiator key
therefore reuse one contact; each request still has a separate response
effect. A live `contact.deleted` tombstone for this deterministic ID prevents
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
deterministic `effectId` when the schema-producing procedure has one. For a
stable rendezvous contact, a request-specific accept/decline effect ID MUST
NOT be copied here: replacement requests share the contact. Such an event
either omits `effectId` or uses a separately defined relationship-stable
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
may be used only for bootstrap or explicit public communication. This event
says nothing about an authenticated peer channel.

#### `contact.peerDidAdded`

```json
{
  "type": "contact.peerDidAdded",
  "blobs": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "did": "did:web:alice.example",
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
older public DID non-preferred without deleting the historical add event.

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
please_ack, ack, from_prior, return_route
```

### 8.2 Intent hash

The intent projection contains the semantic projection plus the immutable
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

`headers` contains every permitted DIDComm top-level header not represented
by a dedicated field, with reserved names forbidden. `intentHash` is unpadded
base64url SHA-256 of the canonical projection. A preparer copies these values
from `message.out`; it MUST NOT substitute its current clock, add a piggyback
acknowledgment, change receipt policy, invent a default header or drop an
unknown one.

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
  3e4f042b-9cb7-568c-a065-59c7c0d2f5ba,
  RFC8785(["v1", effectId])
)

wireId = UUIDv5(
  1bbea408-beff-5583-b67b-5b51393b7e51,
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
    "pleaseAck": [""],
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

A contact target may initially contain only a public DID learned through OOB,
which keeps a rendezvous request offline-first. A channel target is used for
an unattributed authenticated peer or a protocol response pinned to one
channel. A peer-key-null channel cannot be used for an authenticated reply.

Requirements:

- `createdTime` is a durable UTC Epoch Seconds protocol timestamp; user sends
  normally use commit time, while a deterministic effect may derive it from
  the triggering message;
- `expiresTime` is UTC Epoch Seconds or null;
- when non-null, `createdTime < expiresTime`;
- an application protocol may impose a maximum lifetime;
- `pleaseAck` and `ack` are ordered arrays of unique strings and are immutable
  for this intent; `ack` follows oldest-to-newest receive order, the empty
  string may appear at most once in `pleaseAck` to mean this message, and it
  never appears in `ack`;
- `headers` is an RFC 8785 JSON object containing every additional supported
  top-level DIDComm header and none of the reserved fields modeled explicitly;
- `thid`, `pthid`, `expiresTime` and `effectId` are present with null when
  unused;
- `semanticHash` and `intentHash` are computed under section 8;
- `blobs` is the distinct ordered set of `body` followed by `attachments`;
  and
- appending the event requires no network, resolution, mediator or socket.

A preparer MUST use the durable `createdTime` and exact `headers`; current code
or local policy MUST NOT replace the time with `now`, invent defaults, or omit
an unsupported header. Version 3 emits `typ` as
`application/didcomm-plain+json`, always emits `id`, `type`, `from`, `to`,
`created_time` and `body`, omits nullable fields when null, omits acknowledgment
and attachment arrays when empty, and expands every `headers` entry at the
plaintext top level. More than one `message.out` under one `mid` is
allowed only when every field is identical. Reuse of one wire ID with a
different semantic or intent projection is an integrity conflict.

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
hash. A protocol may be stricter; one rendezvous request wire ID pins the
public DID snapshot and recipient generation.

The package names no recipient replica. Public rendezvous and pairwise
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
contains `wireId` in its explicit DIDComm `ack` array. Threading or a natural
response without `ack` is insufficient. `ackMid` identifies the local inbound
ACK-bearing message.

One valid acknowledgment stops automatic retry of every package for the
logical outbound. Duplicate observations are harmless. Acknowledged means
durable receipt by the peer vault, not read or business acceptance.

## 10. Inbound message events

### 10.1 Deterministic inbound MID

For an authenticated or signed innermost message:

```text
mid = UUIDv5(
  689dff5c-d975-5725-898f-267e97e909c1,
  RFC8785(["v1", "authenticated", peerKey, wireId])
)
```

For a truly anonymous message:

```text
mid = UUIDv5(
  689dff5c-d975-5725-898f-267e97e909c1,
  RFC8785(["v1", "anonymous", myKey, wireId])
)
```

The authenticated form omits `myKey`, so a valid repack to another accepted
local DID/key can converge. The two IDs remain distinct and both are stored.

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "blobs": ["bafy...body", "bafy...attachment"],
  "data": {
    "mid": "d770e714-b7f7-5c20-9c8a-d86eeb10a254",
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

- `mid` is the deterministic value above;
- all three hashes are computed under section 8;
- `myKey` is the exact local key that decrypted or verified the message;
- `peerKey` is the authenticated sender fingerprint or null for anonymous;
- `presentedDid` is the exact DID spelling disclosed on the wire, including a
  Peer DID long form when first seen;
- `did` is the canonical peer DID, using Peer DID numalgo-4 short form after
  validating the long form, or null when no peer DID is available;
- `createdTime`, `expiresTime`, `pleaseAck`, `ack`, `headers` and `fromPrior`
  preserve normalized wire headers, with null, empty arrays or an empty object
  when absent; acknowledgment arrays contain unique values and preserve their
  exact wire order for both intent and plaintext hashing, while `headers`
  contains every otherwise-unmodeled top-level member;
- `thid`, `pthid` and `signedBy` are present with null when absent;
- event `author` identifies the receiving replica;
- mediation and delivery ID are null for direct transport without them;
- `bytes` is the canonical retained document byte length; and
- `blobs` is the distinct ordered set of body followed by attachments.

A replica appends this event only after retained blobs are durable. Only then
may it ACK the mediator delivery. Ciphertext that cannot yet be decrypted or
mapped to locally available key material produces no `message.in` and no
pickup ACK; it remains a local deferred delivery and is retried after sync.

### 10.3 Duplicate and conflict rules

For one inbound `mid`:

- equal semantic and intent hashes are one logical message;
- differing `receivedVia`, valid local recipient keys or valid complete
  plaintext hashes are package/replica observations;
- different semantic hash is an application-content integrity conflict;
- equal semantic hash but different intent hash is a control-intent conflict;
- different plaintext hashes are allowed only when each `from`, `to`,
  `from_prior` and resolution chain validates under the same logical target;
- a derivation mismatch in peer key or wire ID is an implementation error;
  and
- every conflict suppresses automatic application effects and disputed ACK
  handling until explicitly resolved.

When semantic and intent hashes agree, `ack` and `pleaseAck` are stable across
valid observations because they are inside the intent projection. Valid
package-specific `from_prior` evidence may differ only alongside a permitted
address transition and remains independently verifiable.

The message fold displays one logical message with all transport observations.
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

For a request to a rendezvous DID, this event is the request-bound resolution
snapshot. A later `from_prior` is verified against this exact event and blob,
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

These events lift durable state defined by `rendezvous/1.0`. The public DID,
relationship DIDs and generations are vault-scoped. A web publisher or server
replica has no special ownership.

### 12.1 `rendezvous.generationConfigured`

```json
{
  "type": "rendezvous.generationConfigured",
  "blobs": [],
  "data": {
    "id": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "did": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "keyGeneration": 0,
    "documentRevision": "019b2a5b-5ab4-7c15-8b86-50650b78558d",
    "documentHash": "THXDWdlKuVgSgQk5PQIThaGKGQRDxoCmBxsfVGnSLos",
    "authenticationKid": "did:web:alice.example#authentication-0",
    "keyAgreementKid": "did:web:alice.example#key-agreement-0",
    "ingressRoutes": [
      "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
    ],
    "relationshipRoute": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "requestPolicy": "ask",
    "maxRequestLifetimeSeconds": 604800,
    "autoLimits": null
  }
}
```

The DID is a live rendezvous `did:web`. The key generation, selected document
revision, exact document blob/hash, ingress routes and relationship route
must already exist in local portable state when this event is appended.

For generation integer `N`, the two selected DID URL fragments are normative:

```text
<did:web>#authentication-N
<did:web>#key-agreement-N
```

`authenticationKid` and `keyAgreementKid` MUST exactly use those fragments
and resolve in the named document revision to the seed-derived keys for
`keyGeneration`.

The generation freezes:

- the public key-agreement key that receives new requests;
- the public authentication key that signs request-specific `from_prior`;
- the exact request-bound document hash;
- the public ingress routes;
- the route encoded into a responder relationship DID;
- maximum request lifetime; and
- admission policy.

`requestPolicy` is `ask`, `auto` or `silent`. Public generations default to
`ask`. When `auto`, `autoLimits` is REQUIRED and contains implementation-
documented positive bounds for new relationships and pending decisions; when
`ask` or `silent`, it is null. A runtime may enforce stricter local or service
limits.

This event is intentionally appended before remote publication. It does not
make the generation live. A generation accepts new requests only after the
exact document revision is observed published and every selected mediated
ingress route is currently reconciled. Before exposing the document, a
publisher MUST upload the configuration, document blob and dependencies to
every sync store required by publication policy so another replica can learn
the JWE `kid` and derive the private key.

All generations for one public DID whose request-acceptance windows overlap
MUST name the same `relationshipRoute`. A route change is activated only after
older generations cannot establish a first relationship. An already
established relationship retains its own DID and route when a replacement
request arrives through another public generation.

One key generation maps to at most one rendezvous generation. Different
values under one generation ID are an integrity conflict.

### 12.2 `rendezvous.generationRetired`

```json
{
  "type": "rendezvous.generationRetired",
  "blobs": [],
  "data": {
    "id": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "acceptUntil": 1789047600
  }
}
```

The generation accepts no request received after `acceptUntil`. Retirement is
terminal. A request remains eligible when it is unexpired, within the
configured maximum lifetime and arrived no later than `acceptUntil`; an old
`created_time` alone is not a clock-skew failure.

The private keys, document blob and request-bound resolution evidence remain
available through at least:

```text
maximum request lifetime
+ mediator message retention
+ configured delivery safety margin
```

The current web document may stop selecting an old key-agreement method for
new requests, but already pinned request packages and historical
`from_prior` verification continue to use retained evidence. Emergency
compromise policy may intentionally shorten this availability.

### 12.3 `rendezvous.requestDecided`

```json
{
  "type": "rendezvous.requestDecided",
  "blobs": [],
  "data": {
    "requestMid": "d770e714-b7f7-5c20-9c8a-d86eeb10a254",
    "requestWireId": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "publicDid": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "publicDidValue": "did:web:alice.example",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "decision": "accept",
    "because": "user",
    "relationship": "e10fc031-4d71-5295-9504-cf50a893ff97",
    "effectId": "RRNYwQN_gicvNmfYbFV3rGXlaJR3POmPq-NX6lFd0cc"
  }
}
```

One request has one durable admission decision. `decision` is `accept`,
`decline` or `ignore`; `because` is `user`, `auto` or `policy`.

- An accept names the stable relationship ID and deterministic accept effect.
- A decline has null `relationship` and the deterministic decline effect.
- An ignore has both fields null and emits no response.

Every deterministic value follows `rendezvous/1.0`. More than one equal event
is a semantic duplicate. Conflicting decisions or effect IDs for one request
are a visible policy conflict and suppress all automatic response effects.

No contact, relationship DID, recipient registration or response is created
before an eligible accept decision. If the deterministic contact for
`(publicDidValue, peerKey)` has a live `contact.deleted` tombstone, an accept
decision is invalid and MUST NOT resurrect it; policy may decline or ignore.

### 12.4 `relationship.established`

```json
{
  "type": "relationship.established",
  "blobs": [],
  "data": {
    "id": "e10fc031-4d71-5295-9504-cf50a893ff97",
    "contact": "34fdcc08-33e7-5268-a850-995c581f7cd1",
    "publicDid": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "publicDidValue": "did:web:alice.example",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "originGeneration": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "ourDid": "4275e88e-2a9d-5b5f-8346-f17ef35b71c5",
    "theirDid": "did:peer:4zQm...initiator-short",
    "theirLongForm": "did:peer:4zQm...initiator-short:z...initiator-input-document"
  }
}
```

This is stable responder relationship state for the pair
`(publicDidValue, peerKey)`. It is independent of request wire ID; replacement
requests from the same authenticated initiator key reuse the same event,
contact and responder relationship DID while getting separate request
responses.

The IDs MUST equal the deterministic derivations in `rendezvous/1.0`.
`originGeneration` is the generation that first created the relationship; it
is immutable historical provenance, not the generation of every replacement
request. `theirDid` is the canonical Peer DID numalgo-4 short form;
`theirLongForm` is the validated first disclosure from the first accepted
request. `ourDid` names a relationship DID whose keys derive from the
deterministic DID entity ID and whose bound route is the origin generation's
`relationshipRoute`. A later request through another generation reuses this
state and does not append a different `relationship.established`.

The relationship, deterministic contact, bootstrap and future relationship
channel attachments, `contact.useDid` and `did.created` SHOULD be appended in
one batch after an accept decision. Equal statements from several replicas
are duplicates. Different values under one relationship ID are an integrity
conflict and suppress acceptance.

Ordinary outbound use of `ourDid` remains pending until at least one
request-specific accept effect for this relationship has a valid
`delivery.acknowledged`. Before that point only accept packages may use the
new DID.


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
`effectId`. A protocol MAY define a stricter scope. In particular,
`rendezvous/1.0` derives stable relationship state from `(public DID,
peer key)` while deriving separate accept or decline effects from that stable
relationship and the individual request wire ID.

- Automatic contacts use the deterministic contact rule in section 7.
- Automatic outbound messages derive stable `mid` and `wireId` values in
  section 9.
- Handler-produced events SHOULD include `effectId` when their schema
  permits diagnostics and duplicate recognition.
- An external system call MUST use `effectId` as its idempotency key or
  explicitly accept at-least-once side effects.

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
  web document revision, or belongs to a non-expired rendezvous generation.

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
  key-agreement generation for new requests;
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

For each rendezvous generation:

- exactly one consistent `rendezvous.generationConfigured` names a live
  rendezvous web DID, key generation, exact document revision/hash, selected
  authentication and key-agreement fragments, non-empty ingress route set,
  relationship route, maximum lifetime and request policy;
- the generation is **live** only when the exact selected revision has a
  matching `did.documentPublished` observation and every mediated ingress
  route is currently reconciled;
- `rendezvous.generationRetired` supplies a terminal `acceptUntil` boundary;
  and
- missing, retired or inconsistent dependencies make it unusable and visible
  as configuration conflict.

The local key that decrypts a request must map to exactly one configured
generation. If the event/key has not arrived at this replica, decryption is
deferred and the mediator delivery remains unacknowledged. If more than one
generation claims the same selected key, automatic handling stops.

Group `rendezvous.requestDecided` by request MID/wire ID. Equal values are one
decision. Competing decisions or effect IDs are a policy conflict and produce
no automatic response. An accept is valid only for an eligible generation,
valid request lifetime and non-tombstoned deterministic contact.

Group `relationship.established` by deterministic relationship ID. Equal
stable values are one relationship. The identity is derived from public DID
and authenticated initiator key, not request wire ID, so replacement requests
reuse it. Different values are an integrity conflict.

A valid relationship contributes:

- one deterministic contact;
- its authenticated bootstrap channel;
- the future relationship channel;
- one local relationship DID and canonical remote Peer DID; and
- zero or more request-specific accept effects from valid accept decisions.

The responder relationship is pending for ordinary outbound use until at
least one corresponding accept message has a valid `delivery.acknowledged`.
Before confirmation only accept packages may use the new local DID. This
prevents an ordinary pairwise message from overtaking its proof.

On the initiator side, a valid `peer.transitioned` changes only the named
contact's current peer DID. The public predecessor remains usable for other
contacts and new rendezvous requests.

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
- `writeTo[]` is every non-conflicted current peer DID/channel for which a
  package can currently be prepared; and
- `thread` is the logical message union below.

A responder rendezvous relationship whose accept has not been acknowledged is
visible as pending and is excluded from ordinary `writeTo[]`. Queued ordinary
outbound content remains durable but cannot be prepared until confirmation.

When a public rendezvous DID has transitioned to a relationship DID in this
component, ordinary `writeTo` prefers the relationship DID and does not use
the public DID as fallback unless an application explicitly starts another
rendezvous flow.

A fold MUST NOT select one of several current relationship ends by clock
order. Transition ambiguity is a visible conflict. A tombstoned deterministic
rendezvous contact is never recreated by another event with the same ID.

### 14.8 Inbound message fold

Group `message.in` by deterministic `mid`.

For each group:

- equal `semanticHash` and `intentHash` is one logical message;
- collect every distinct valid plaintext hash, receiving channel,
  `receivedVia` and author observation;
- different semantic hash is an application-content integrity conflict;
- equal semantic hash with different intent hash is a control-intent
  integrity conflict;
- a plaintext variant is accepted only when its package-level address and
  security evidence validate;
- erasure is applied before blob presence; and
- any conflict suppresses automatic effects and disputed ACK processing.

A thread contains the logical message once, positioned by the earliest
canonical observation unless an application protocol defines another display
time.

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
- `acknowledged` is true if a valid authenticated inbound `ack` names the
  wire ID on an allowed contact-scoped continuation;
- `submitted` is true if any package has `delivery.submitted`;
- a message-scoped non-retryable failure is terminal for automatic work;
- an expired intent stays terminal even if a late submission or ACK arrives
  as historical evidence; and
- retryable failures remain diagnostic attempts.

The operational precedence is:

```text
conflict
acknowledged
held
terminal-failure
prepared/submitted/retryable
queued
```

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
authenticated request but cannot prevent distinct peers from using a copied
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

### 16.5 Configure and publish a rendezvous DID

1. choose a public `did:web` string under a controlled domain/path;
2. mint a UUIDv7 DID entity ID and derive generation-0 authentication and
   key-agreement keys;
3. append `did.created` with role `rendezvous`;
4. create or reuse public ingress and relationship routes and append
   `did.routesSelected`;
5. construct exact canonical `did.json`, store it and append
   `did.documentPrepared`;
6. append `did.documentSelected`;
7. append `rendezvous.generationConfigured`, including exact document hash,
   normative key fragments, request policy, maximum request lifetime, ingress
   routes and relationship route;
8. upload all events and blobs from steps 1–7 to every sync store required by
   publication policy and verify they are retrievable;
9. publish the document provisionally through deployment-specific
   authenticated means and fetch the standard `did:web` URL to verify exact
   bytes, hash and DID `id`;
10. for every mediated ingress route, reconcile recipient registration using
    the now-resolvable authentication method and append
    `did.routeRegistered` after success;
11. fetch the document again and verify the selected bytes remain current;
12. append `did.documentPublished` only after publication and all mediated
    registrations verify; and
13. optionally append `did.disclosed` for a reusable OOB invitation or public
    profile.

The generation is configured before publication but becomes live only after
step 12 and current route reconciliation. This ordering lets another replica
learn the new JWE `kid` and derive the same secret before public traffic can
arrive. A lagging replica that still cannot decrypt retains its mediator
delivery without ACK until sync completes.

The public DID belongs to the vault, not the process serving `did.json`.

### 16.6 Initiate rendezvous

1. learn the peer rendezvous DID through a URL, QR code, directory or manual
   input;
2. create/select a contact and append `contact.peerDidAdded` for the public
   DID;
3. create one local relationship `did:peer:4`, store both forms and associate
   it with the contact;
4. write `rendezvous/1.0/request` and append `message.out`, freezing
   `createdTime`, `expiresTime`, `pleaseAck == [""]`, body and hashes; this may
   happen offline;
5. resolve the public DID before first preparation and durably store exact
   `peer.resolved` document bytes/hash and selected key IDs;
6. append `channel.firstSeen` and `contact.attached` for the bootstrap channel
   with `because == "rendezvous"`, preferably in the same batch as
   `message.prepared`;
7. prepare and submit only against the request-bound snapshot/generation; and
8. retry until explicit `ack` in accept/decline/problem response, expiry or
   hold.

If current time reaches the durable expiry before preparation or retry, append
message-scoped non-retryable `delivery.failed` with code `expired` and submit
nothing. A replacement request uses a new wire ID but normally reuses the same
initiator relationship key unless the contact was deleted.

Attaching the bootstrap channel in step 6 allows a decline or problem response
from the public DID to attribute to this contact even before pairwise handoff.

### 16.7 Decide and accept or decline rendezvous

For a mediator delivery that may be a rendezvous request:

1. attempt decryption using the protected recipient `kid`;
2. if the key/generation is not locally available, retain the delivery
   unacknowledged, sync/refold and retry; do not append `message.in` or create
   relationship state;
3. after successful authenticated decryption, append `message.in` and ACK
   pickup under section 16.9;
4. map the local key to exactly one live generation, validate request-bound
   document hash/fragments, maximum lifetime, current expiry, receiving route
   and tombstone state;
5. apply the generation's `ask`, `auto` or `silent` policy and enforce rate,
   pending-request, relationship, recipient and storage limits;
6. append one `rendezvous.requestDecided` before response or relationship
   effects.

For `ignore`, stop without a response. For `decline`, derive the deterministic
decline effect, append `message.out` with `thid == request wire ID`,
`ack == [request wire ID]` and `pleaseAck == [""]`, then retry until its ACK,
expiry or hold.

For `accept`:

1. derive stable relationship, local DID and contact IDs from public DID and
   authenticated initiator key; request wire ID is not part of those IDs;
2. reject acceptance when the deterministic contact is tombstoned;
3. if no stable relationship exists, derive the responder relationship DID's
   keys and both Peer DID forms using this request generation's relationship
   route; otherwise reuse the existing DID, route and origin generation;
4. for a new relationship append, preferably in one `appendAll`,
   `contact.created`, bootstrap and future-channel `contact.attached`,
   `did.created`, `contact.useDid` and the request-independent
   `relationship.established`; `contact.created` MUST NOT carry the
   request-specific response effect ID; for a replacement request do not
   rewrite that stable state;
5. reconcile recipient registration for the canonical short-form DID;
6. derive the request-specific accept effect and append `message.out` with
   explicit `ack == [request wire ID]`, `pleaseAck == [""]`, deterministic
   IDs and exact request-specific `from_prior` inputs;
7. prepare `accept`, disclosing the responder Peer DID long form, signing
   `from_prior` with the request-bound public authentication key; and
8. retry accept until ultimate ACK, expiry or hold.

Repeated requests with new wire IDs and the same initiator key reuse the
stable relationship but obtain their own decision and threaded response.
Conflicting decisions or deterministic values suppress automatic effects.
Ordinary outbound messages from the responder relationship DID remain queued
but unprepared until one accept for that relationship is acknowledged.

### 16.8 Send an ordinary message

The synchronous full-vault send operation:

1. writes attachment blocks;
2. writes the stored message document;
3. selects durable `createdTime`, optional `expiresTime`, exact ordered
   `pleaseAck` and piggyback `ack` values, and a complete `headers` map;
   protocol-generated effects include only acknowledgments mandated by their
   triggering messages;
4. computes semantic and intent hashes;
5. appends `message.out`; and
6. returns `mid` and `wireId`.

It performs no network operation.

Any replica may later:

1. stop if the message is held, acknowledged, terminally failed or expired;
2. fold the target contact/channel;
3. defer if the selected responder relationship is awaiting handoff
   confirmation;
4. choose a valid sender DID, peer DID/key and exact resolution evidence;
5. construct the complete plaintext by copying all intent-time headers rather
   than generating a new `created_time`, defaulting an extension header or
   silently dropping one;
6. compute plaintext hash, encrypt, store exact envelope bytes and append
   `message.prepared`;
7. submit directly or through Routing 2.0 with `packageId == forward.id`;
8. append submitted or failed observation; and
9. retry until ultimate acknowledgment or terminal state.

A new package may change `from`, `to`, selected keys or `from_prior` only
under the validated contact-scoped repack rules while preserving semantic and
intent hashes. A lease may reduce duplicate work but is not required for
correctness.

### 16.9 Receive a message

For every pickup or direct delivery:

1. if the ultimate key is locally unknown, keep a pickup delivery pending,
   sync/refold and retry without pickup ACK;
2. authenticate, decrypt and validate the complete innermost message;
3. derive channel, deterministic MID, semantic hash, intent hash and exact
   plaintext hash;
4. validate Peer DID long form on first disclosure and preserve the exact
   presented/canonical forms;
5. write retained body and attachment blocks and the stored message document;
6. append `message.in` durably together with applicable `channel.firstSeen`,
   exact `peer.resolved`, validated `peer.transitioned`, required contact
   attachment and lifted profile observations;
7. only then ACK this replica's mediator delivery;
8. if the logical message is conflict-free, process its validated `ack` array
   into idempotent `delivery.acknowledged` events;
9. schedule idempotent automatic effects or rendezvous admission decisions;
   and
10. send an ultimate ACK after durable commit when requested.

Steps 5–6 SHOULD use one atomic batch where supported. A backend without an
atomic batch appends `message.in` first, then derived observations; no lifted
observation is sole evidence for an uncommitted message.

A crash before durable message commit leaves the mediator delivery pending. A
crash after commit but before pickup ACK causes redelivery and another valid
duplicate observation. A natural response acknowledges a request only when
its explicit `ack` array names the request wire ID.


### 16.10 Retire a replica

1. append `replica.retired` for the target;
2. synchronize the event;
3. every active replica reconciles retirement to every shared mediation
   account; and
4. labels and historical events remain.

This procedure does not secure a stolen seed. Security recovery requires
root or communication-key rotation outside `replica-mediation/1.0`.

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
5. preserve a shared public rendezvous DID unless separately retired; and
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
objects. Public DID entities, selected document revisions, relationship DIDs
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
`did:web`, it may reconcile and publish the same document revision. This does
not make it the owner of the public DID in vault semantics. A restored full
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
- A rendezvous DID is intentionally public, reusable and correlatable. DNS,
  the web publisher, resolvers and the mediator may observe discovery
  metadata.
- A relationship DID SHOULD be disclosed only through encrypted interaction
  and MUST NOT appear in a reusable public invitation or public DID document.
- A valid public-to-pairwise `from_prior` is stored only as contact-scoped
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
  not provide an append-only public DID history.
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
2. A full replica on a server has the same event and pickup semantics as a
   local full replica; a thin client without seed is not an author.
3. Mediation and communication keys created by one replica are derivable by
   another full replica.
4. Replica retirement changes delivery policy but does not invalidate events
   or revoke the shared seed.
5. A send commits body, attachments and `message.out` with all networking
   disabled.
6. `message.out` freezes created time, expiry, receipt request and piggyback
   ACK array; preparers do not substitute local clocks or headers.
7. Semantic hash covers application ID/type/thread/body/ordered attachments;
   intent hash additionally covers immutable control headers; plaintext hash
   covers one complete DIDComm plaintext.
8. Two packages for one outbound may differ in valid address/security
   evidence but agree on wire ID, semantic hash and intent hash.
9. Changing body, type, thread or attachment order under one wire ID is a
   semantic conflict.
10. Changing created time, expiry, `please_ack` or `ack` under one wire ID is
    an intent conflict and triggers no disputed control effect.
11. Retrying one package preserves identical envelope bytes and package ID.
12. A permitted repack changes package ID and plaintext hash while preserving
    message ID, wire ID, semantic hash and intent hash.
13. HTTP success produces `delivery.submitted`, never acknowledgment.
14. A natural response acknowledges an outbound only when its explicit
    authenticated `ack` array names the wire ID.
15. A message that reaches durable expiry records message-scoped
    non-retryable failure and is no longer prepared or submitted.
16. More than one replica receiving valid variants of one message derives the
    same MID and one logical message.
17. Different semantic or intent hash under one inbound MID is a conflict and
    suppresses automatic effects and disputed ACK processing.
18. Pickup ACK follows durable `message.in` and retained blobs.
19. Ciphertext whose JWE `kid` is not yet available remains unacknowledged at
    the mediator and is retried after sync.
20. `peer.resolved` retains exact canonical DID document bytes/hash and exact
    presented/canonical DID forms.
21. Peer DID numalgo 4 uses long form on first disclosure and canonical short
    form afterward and for mediator registration.
22. `peer.transitioned` verifies `from_prior` against the exact named
    historical resolution event; missing evidence defers rather than rejects.
23. A reusable public invitation contains a rendezvous DID and no relationship
    DID.
24. A rendezvous generation configuration is durable and sync-published
    before public document exposure and is not live until publication and
    mediated-route registration verify.
25. Public generation policy defaults to `ask`; `auto` is explicit and
    bounded; `silent` produces no liveness response.
26. A rendezvous request can be queued offline and is not rejected solely for
    old `created_time` while it remains unexpired and within maximum lifetime.
27. The initiator attaches the authenticated bootstrap channel before or with
    request package preparation, allowing decline/problem attribution.
28. Accept, decline and request-triggered problem responses explicitly ACK the
    request wire ID.
29. Two request wire IDs from the same `(public DID, initiator key)` derive one
    relationship/contact/responder DID and separate threaded response effects.
30. A tombstoned deterministic contact is not resurrected; reconnect requires
    a fresh initiator relationship key.
31. Concurrent replicas accepting one request derive equal decision,
    relationship, contact, DID and response IDs.
32. The responder discloses a relationship Peer DID long form in accept; the
    initiator stores and uses its short form thereafter.
33. Ordinary responder pairwise packages remain deferred until at least one
    accept for that relationship is ultimately acknowledged.
34. A valid `from_prior` changes current peer DID only in the named contact;
    the public DID remains active for unrelated initiators.
35. Two contacts may transition from one public DID to different pairwise DIDs
    without becoming one identity component.
36. A public and pairwise DID may select the same reusable mediated route and
    receive identical per-replica fan-out.
37. `did.routeRegistered` is historical observation; reconnect still queries
    and reconciles mediator state.
38. A selected `did:web` revision is current only when fetched bytes/hash and
    DID `id` match.
39. Established pairwise traffic remains usable when the public publisher is
    unavailable.
40. A late replica replays unexpired mediator messages independently of other
    replicas' ACKs.
41. A retired or terminally failed package no longer pins its encrypted
    envelope unless another event holds it.
42. Erasure is checked before block presence; missing non-erased bytes are not
    displayed as deletion.
43. Contact merge is an order-independent undirected component and multiple
    current relationship ends are surfaced rather than chosen by LWW.
44. Restore without `local/` creates a new replica that resumes mediation,
    pickup, sync, publication reconciliation and eligible outbox work.
45. Extension purge removes its store but leaves lifecycle events.
46. Shuffling all events leaves every fold result unchanged.
47. Sync configuration survives folder export; retiring one sync store does
    not delete remote ciphertext or block another usable store.
48. No correctness rule depends on one replica remaining online.
