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

A version-3 `did:peer` relationship DID has generation `0`; changing its
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
    "firstDid": "did:peer:4zQm..."
  }
}
```

`kind` is one of:

```text
authcrypt
anoncrypt
signed
```

A replica appends this observation when it first encounters a channel
for which the converged vault has no equivalent observation. Concurrent
duplicates are harmless. If one `peerKey` is associated with different
public-key bytes, the channel fold reports an integrity conflict.

`firstDid` is optional and records the DID claimed or resolved at first
observation. It is evidence, not attribution.

## 5. Mediation, communication DIDs and routes

Mediation arrangements, communication DIDs and their private keys belong to
the vault. Their meaning never depends on the event author or the process
that happens to publish a web document.

A communication DID has one of two roles in version 3:

```text
rendezvous    public reusable discovery, profiled as did:web
relationship  pairwise ongoing communication, profiled as did:peer
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

For a relationship `did:peer`, `boundRoute` is REQUIRED and names the one
route encoded into the peer DID. For a rendezvous `did:web`, `boundRoute` is
null because selected document revisions may advertise one or more routes.

A deterministic rendezvous handler may use a UUIDv5 `id`; ordinary creation
uses UUIDv7. Repeating one ID with different identity fields is an integrity
conflict.

A relationship variant has this shape:

```jsonc
{
  "id": "50386028-0062-554d-9f0a-a5a21d300b56",
  "did": "did:peer:4zQm...",
  "method": "peer",
  "role": "relationship",
  "generation": 0,
  "authenticationKeys": ["did/50386028-0062-554d-9f0a-a5a21d300b56/authentication/0"],
  "keyAgreementKeys": ["did/50386028-0062-554d-9f0a-a5a21d300b56/key-agreement/0"],
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

For a relationship `did:peer`, the list MUST contain exactly its
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
    "documentHash": "1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc",
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
    "documentHash": "1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc",
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

`relationship_id` is the deterministic value from `rendezvous/1.0`, which
includes the exact public DID, authenticated initiator key and request wire
ID. Transport retry through another ingress route in the same public key
generation therefore does not create another contact.

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
deterministic `effectId` when the schema-producing procedure has one.

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

## 8. Stored message document

Message content is kept in blob blocks. The body root of `message.out`
and `message.in` names canonical UTF-8 JSON with this shape:

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

- the document is RFC 8785 canonical JSON;
- `body` is the DIDComm application body object;
- `attachments` is ordered as on the logical application message;
- each descriptor's `root` is also listed in the event's
  `data.attachments` and envelope `blobs`;
- optional DIDComm attachment metadata may be retained as additional
  documented fields; and
- attachment bytes themselves are separate profile blobs.

On inbound receipt, `contentHash` is computed over the canonical original
innermost DIDComm plaintext before lifting. The stored document may be a
normalized retained representation rather than byte-for-byte wire JSON.
The local trace, if enabled, owns any raw wire representation and its
retention.

Inline `data.base64` attachments are decoded before storage. Inline
`data.json` attachments are stored as RFC 8785 canonical JSON bytes.
External links are not automatically fetched merely because a message
names them. Object-share roots are accepted only after their blocks and
hashes verify.

## 9. Outbound message events

### 9.1 IDs

- `mid` is the vault's message entity ID.
- `wireId` is the innermost DIDComm plaintext `id`.
- `packageId` identifies one exact encrypted inner envelope and is used as
  Routing 2.0 `forward.id`.
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

Concurrent replicas executing the same effect therefore create semantic
duplicates rather than different logical replies.

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
    "body": "bafy...body",
    "attachments": ["bafy...attachment"],
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

A contact target may initially contain only an unverified public DID learned
through OOB. This is how a `rendezvous/1.0` request remains offline-first.
The preparing replica resolves and validates the target later.

A channel target is used for an unattributed but authenticated peer or a
protocol reply that must use a particular channel. A peerKey-null channel
MUST NOT be used for an authenticated reply.

`thid`, `pthid` and `effectId` are present with JSON null when unused.
`blobs` MUST equal the distinct ordered set consisting of `body` followed by
`attachments`.

Appending this event is the complete public send operation of a full vault
runtime. It MUST NOT require network access, DID resolution, a current socket
or a currently reachable mediator.

More than one `message.out` event with the same `mid` is allowed only when
every semantic field is identical. Different content under one `mid`, or one
`wireId` used by different outbound intent content, is a message integrity
conflict.

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
    "recipientDid": "did:peer:4zQm...",
    "plaintextHash": "1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc",
    "envelope": "bafy...encrypted-envelope",
    "envelopeHash": "1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc"
  }
}
```

This materialization makes one exact normalized inner DIDComm encrypted
envelope recoverable by every replica.

Requirements:

- `senderDid` names a non-retired local DID entity selected for the target;
- `myKey` is one of that DID generation's key-agreement keys and authorizes
  the plaintext `from` value;
- the inner plaintext `id` is `wireId`;
- the plaintext `to` identifies `recipientDid`;
- `plaintextHash` is unpadded base64url SHA-256 of the RFC 8785 canonical
  innermost plaintext;
- every package for one `mid` uses the same canonical plaintext, `senderDid`
  and authenticated sender key;
- the message requests ultimate acknowledgment as required by
  `distributed-delivery/1.0`;
- the envelope blob contains exact normalized encrypted-message bytes;
- `envelopeHash` is unpadded base64url SHA-256 of those bytes;
- `packageId` is a UUIDv7 and the outer Routing 2.0 `forward.id`;
- every retry of this package uses the same envelope bytes; and
- re-encryption for another peer key or packing parameter creates a new
  package ID while preserving `mid` and `wireId`.

The package does not name a recipient replica. A public rendezvous DID and a
pairwise relationship DID are prepared by the same rules.

More than one active package may exist for one message during key, DID or
route transition and replica races.

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
it. It does not affect the logical message or another package.

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

This observation means only that one transport endpoint accepted the
package attempt. `endpoint` is the selected direct endpoint or final
transport endpoint after resolving a mediator DID. It never means the route
existed, the mediator retained the message, a replica picked it up or the
ultimate peer committed it.

Any replica may append this observation. Concurrent submissions and attempts
through different advertised routes are expected.

### 9.6 `delivery.failed`

```json
{
  "type": "delivery.failed",
  "blobs": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "phase": "submit",
    "code": "network-timeout",
    "retryable": true
  }
}
```

`phase` is `resolve`, `prepare` or `submit`. `packageId` is null when no
package exists yet. A failure is diagnostic state for retry policy and is
never terminal by itself.

Sensitive error strings belong in local trace. `code` is a stable,
non-secret machine value.

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

`because` is `user` or `policy`. A hold is a vault-wide decision to stop
automatic preparation and submission. There is no `imported` hold.

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

`hold` is the `eid` of one `delivery.held` event. A message is held while at
least one hold event for it has no release. Explicit references avoid
clock-order ambiguity.

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

This observation is appended only after an authenticated ultimate peer
message acknowledges `wireId` under `distributed-delivery/1.0`. `ackMid`
identifies the local inbound ACK message.

One valid acknowledgment stops automatic retry of every package for the
logical outbound message. Duplicate acknowledgment events are harmless.
Acknowledged means durable receipt by the peer vault, not read or accepted by
a business workflow.

## 10. Inbound message events

### 10.1 Deterministic inbound MID

For an authenticated or signed innermost message, compute:

```text
mid = UUIDv5(
  689dff5c-d975-5725-898f-267e97e909c1,
  RFC8785(["v1", "authenticated", peerKey, wireId])
)
```

For a truly anonymous innermost message, compute:

```text
mid = UUIDv5(
  689dff5c-d975-5725-898f-267e97e909c1,
  RFC8785(["v1", "anonymous", myKey, wireId])
)
```

The authenticated form intentionally omits `myKey`. Re-encrypting the same
canonical plaintext to another accepted key generation or another recipient
DID of this vault therefore converges on one message when the authenticated
peer key and wire ID are unchanged. The anonymous form includes `myKey`
because it has no authenticated peer namespace.

This does not replace `wireId`. The two IDs remain distinct, and the receiver
preserves both.

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "blobs": ["bafy...body", "bafy...attachment"],
  "data": {
    "mid": "d770e714-b7f7-5c20-9c8a-d86eeb10a254",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "contentHash": "1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "did": "did:peer:4zQm...",
    "thid": null,
    "pthid": null,
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
- `contentHash` is unpadded base64url SHA-256 of the RFC 8785 canonical
  original innermost DIDComm plaintext;
- `myKey` is the exact local key that decrypted or verified the message and
  maps to one vault DID entity and generation;
- `did` is the peer DID under which the authenticated peer key was resolved
  for this message, or null when none is available;
- `thid`, `pthid` and `signedBy` are present with null when absent;
- the event `author` identifies the receiving replica;
- `mediation` and `deliveryId` are null for a direct transport that has no
  such value;
- `bytes` is the byte length of the canonical stored message document; and
- `blobs` is the distinct ordered set of `body` followed by `attachments`.

A replica appends the event only after all retained blobs are durable. Only
then may it acknowledge its mediator delivery.

A rendezvous request addressed to a public DID is still an ordinary
`message.in`; `rendezvous/1.0` lifts deterministic relationship state only
after this event is durable.

### 10.3 Duplicate and conflict rules

For one inbound `mid`:

- equal `contentHash`, message metadata and retained roots are duplicate
  observations of one logical message;
- differences in `receivedVia` are expected replica/transport observations;
- for an authenticated message, differences in `myKey` are expected when one
  retry reached another accepted key or DID of this vault;
- different `contentHash` is an integrity conflict;
- a different `peerKey` or wire ID under the same authenticated MID, or a
  different `myKey` or wire ID under the same anonymous MID, is a
  derivation/implementation error; and
- a conflict suppresses automatic effects until surfaced or resolved by an
  application-specific decision.

The message fold displays one logical message with all `receivedVia`
observations. Event authorship may show which replicas durably received it,
but does not create separate conversation messages.

Anonymous messages have `peerKey == null`; an attacker can intentionally
reuse a wire ID. Applications SHOULD impose stricter replay and automatic
handling policy for them.

### 10.4 Pickup versus ultimate acknowledgment

A Message Pickup `messages-received` acknowledgment is not a vault event. It
is local mediator state for one replica and is sent after the durable
`message.in` append.

The ultimate peer ACK is an end-to-end application message. It is itself
recorded as `message.in` and may produce `delivery.acknowledged` events for
outbound wire IDs named in its `ack` header.

## 11. Peer and profile observations

All events in this section carry a complete channel key. Peer DID evidence is
kept distinct from contact decisions and from our own DID entities.

### 11.1 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "blobs": [],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2/key-agreement/0",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "did": "did:web:alice.example",
    "keys": ["did:key:z6LS...", "did:key:z6Mk..."],
    "service": "did:web:mediator.example"
  }
}
```

The event says the authenticated `peerKey` was actually found under `did`
when resolving or unpacking this channel. Only the key that the envelope
proved creates an evidence edge. Other entries in `keys` are context and
MUST NOT be treated as proof of control.

`service` is the selected DIDComm service URI or null when unavailable. It is
an observation, not a permanent delivery route.

A client SHOULD append only when the latest equivalent resolution differs,
but duplicate observations are harmless.

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
    "to": "did:peer:4zQm...alice-for-us",
    "fromPrior": "eyJ...",
    "mid": "689dff5c-d975-5725-898f-267e97e909c1"
  }
}
```

This event is lifted only from a valid DIDComm `from_prior` statement in the
named inbound message. `scope` is exactly `relationship` in version 3.
`contact` is REQUIRED and the peer key must be attached or attributable to
that contact after processing the message.

The event means that, for this contact, the peer moved from `from` to `to`.
The processing procedure MUST also attach the authenticated channel carrying
the new DID to this contact, preferably in the same `appendAll`. It does not
globally union the DIDs and does not retire `from` outside the relationship.
This is essential when one public rendezvous DID transitions to a different
pairwise DID for every contact.

A later valid transition may continue from `to` to another DID inside the
same contact. Competing current ends are a visible relationship conflict;
canonical time does not choose one.

The JWT is evidence, not a blob reference.

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

These events lift the durable state created by `rendezvous/1.0`. They do not
make the public DID a replica address or turn the web publisher into a
special vault owner.

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
    "ingressRoutes": [
      "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
    ],
    "relationshipRoute": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
  }
}
```

The DID must be a non-retired rendezvous `did:web`. The key generation,
document revision, every ingress route and the relationship route must exist.
The document must advertise that key generation and every ingress route.

The generation freezes the inputs used to accept a request:

- the key-agreement key that decrypted it;
- the authentication key that signs `from_prior`;
- the non-empty set of public routes through which the request may arrive;
- the `relationshipRoute` embedded in the responder's new relationship DID;
  and
- the public document evidence expected by the initiator.

The relationship route MAY also be one of the ingress routes and will
normally be the same mediated route, but it need not be a publicly direct
route. One local key generation maps to at most one rendezvous generation. A change
to the active key generation, ingress routes or relationship route for new
requests creates a new key generation and a new rendezvous-generation ID.
Conflicting configurations under one ID are an integrity conflict.

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

The generation accepts no request received after `acceptUntil`. Retirement
is terminal. The underlying seed-derived keys, document blobs and evidence
remain available for verification and recovery.

A normal rollover SHOULD keep the old private keys, accepted ingress routes
and mediator recipient state usable through the maximum request lifetime,
mediator retention and allowed clock skew. The current web document SHOULD
keep the old authentication method verifiable for delayed `from_prior`
validation, although it may remove the old key-agreement method from the
active `keyAgreement` relationship. Emergency compromise policy may shorten
that period.

### 12.3 `relationship.established`

```json
{
  "type": "relationship.established",
  "blobs": [],
  "data": {
    "id": "a50ce9c1-bbc1-5dac-8a48-3323eee29063",
    "requestMid": "d770e714-b7f7-5c20-9c8a-d86eeb10a254",
    "requestWireId": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
    "contact": "b2e533aa-5047-5392-9dc6-647663fda4af",
    "rendezvousGeneration": "019b2a5d-ea71-72f4-9d99-850d69ee8030",
    "ourDid": "c2e062e8-8952-5140-8493-6e774086c4db",
    "theirDid": "did:peer:4zQm...initiator",
    "effectId": "1YdHe9UZblWe9irqx3k_tZT7oqjvmNWzFTGHjM6H3Oc"
  }
}
```

This is the responder's durable decision to accept one authenticated
rendezvous request. The IDs and `effectId` MUST equal the deterministic
derivations in `rendezvous/1.0`; this example uses that document's exact test
vector.

The named `ourDid` must be a relationship `did:peer` whose generation-0 keys
are derived from that deterministic DID entity ID and whose bound route is
the configured rendezvous generation's `relationshipRoute`. `theirDid` is the request's authenticated
`from` DID.

The relationship event, deterministic contact, both the bootstrap and
future relationship-channel attachments, `contact.useDid` and `did.created`
SHOULD be appended atomically. Several replicas racing on the same request
produce semantic duplicates. Different values under one relationship ID are
an integrity conflict and suppress the automatic acceptance.

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
`rendezvous/1.0` derives its acceptance effect from the deterministic
relationship ID so one peer wire ID cannot collide across distinct public
DIDs.

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
- a peer DID has exactly one configured, non-retired bound route and does not
  add later key generations;
- a web DID has null `boundRoute`, every selected revision has the correct
  DID `id`, and a rendezvous profile exposes exactly one current
  key-agreement generation for new requests;
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
  rendezvous web DID, key generation, document revision, non-empty ingress
  route set and relationship route;
- `rendezvous.generationRetired` supplies a terminal `acceptUntil` boundary;
- requests received after that boundary are not eligible for automatic
  acceptance; and
- missing, retired or inconsistent inputs make the generation unusable and
  visible as a configuration conflict.

The local key that decrypted a rendezvous request selects its key generation,
and the receiving transport must correspond to one of that generation's
ingress routes. If more than one live rendezvous generation claims the same
key generation, automatic handling stops rather than choosing by time. One
request wire ID is pinned to one public key generation by `rendezvous/1.0`;
retry through another ingress route in the same generation is a duplicate,
while use of another key generation is a protocol conflict that suppresses
automatic relationship creation.

Group `relationship.established` by deterministic relationship ID. Equal
semantic values are one accepted relationship. Different values are an
integrity conflict and suppress acceptance packages and effects.

A valid established relationship contributes:

- one deterministic contact;
- the authenticated bootstrap channel;
- the future relationship channel formed by the local pairwise key and the
  authenticated initiator key;
- one local relationship DID used by that contact; and
- one automatic `rendezvous/1.0/accept` effect.

On the initiator side, a valid `peer.transitioned` changes only the named
contact's current peer DID. The public predecessor remains usable for other
contacts and new rendezvous requests.

### 14.6 Peer evidence and contact-scoped attribution

Build an evidence graph whose nodes are:

- authenticated channels with `peerKey != null`; and
- peer DID strings.

The only global evidence edge is:

- `peer.resolved`: the exact channel to the DID under which its authenticated
  peer key was found.

A `peer.transitioned` edge is not global. It belongs only to its named contact
component. Likewise, `contact.peerDidAdded` is an outbound contact decision,
not proof shared by all contacts.

Exclude mediation channels from contact attribution.

For a channel, collect every live `contact.attached` whose channel lies in its
evidence component, then collapse contact IDs by `contact.merged`:

- none: unattributed;
- one contact component: attributed to it;
- several: multi-valued attribution conflict.

The fold never attributes an anonymous `peerKey == null` channel through the
graph.

Within one contact component, apply its valid `peer.transitioned` events as a
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
- `thread` is the logical message union described below.

When a public rendezvous DID has transitioned to a relationship DID in this
component, ordinary `writeTo` prefers the relationship DID and does not use
the public DID as a fallback unless an application explicitly starts a new
rendezvous flow.

A fold MUST NOT select one of several current relationship ends merely by
clock order. Transition ambiguity is a visible conflict.

### 14.8 Inbound message fold

Group `message.in` events by `mid`.

For each group:

- equal semantic skeleton and `contentHash` is one logical message;
- collect every distinct receiving channel, `receivedVia` and author
  observation;
- different `contentHash` or semantic skeleton is an integrity conflict;
- erasure state is applied before blob presence; and
- automatic effects are disabled for a conflict.

A thread contains the logical message once, positioned by the earliest
canonical `message.in` observation unless an application-specific protocol
defines another display time.

### 14.9 Outbound message and delivery fold

Group `message.out` by `mid`. Multiple identical intent events are one
logical outbound message. Different intent content under one `mid` is a
conflict.

For a valid outbound message:

- `packages[]` is every consistent `message.prepared` by `packageId`;
- all packages MUST agree on `wireId`, `plaintextHash`, `senderDid` and
  `myKey`, or the logical outbound message is conflicted;
- a package is inactive after `message.packageRetired`;
- unresolved holds are `delivery.held` events not named by any
  `delivery.released`;
- `acknowledged` is true if any valid `delivery.acknowledged` names the
  message's wire ID on an allowed contact-scoped channel continuation;
- `submitted` is true if any active or historical package has a
  `delivery.submitted` observation; and
- failures remain diagnostic attempts, not final state.

The operational state precedence is:

```text
conflict
acknowledged
held
prepared/submitted/retryable
queued
```

Any full replica may process a valid queued or retryable message. Authorship
never limits outbox ownership. Import or synchronization does not create a
hold.

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

This procedure is used for an initiator before a rendezvous request and for
ordinary manually created pairwise relationships.

1. choose one configured, non-retired mediated or direct route, creating it
   with `route.configured` first when necessary;
2. mint a UUIDv7 DID entity ID, unless a protocol requires deterministic
   UUIDv5;
3. derive generation-0 authentication and key-agreement keys;
4. construct the peer DID from those keys and route;
5. append `did.created` with role `relationship` and the bound route;
6. append `did.routesSelected` if required by the implementation; and
7. associate it with the intended contact through `contact.useDid`.

For a mediated route, recipient registration and `did.routeRegistered` MUST
succeed before the DID is disclosed or used as a return address.

Changing a peer DID's keys or route creates a new relationship DID and uses a
contact-scoped `peer.transitioned`; the old DID entity is not edited.

### 16.5 Configure and publish a rendezvous DID

1. choose or create a public `did:web` string under a controlled domain/path;
2. mint a UUIDv7 DID entity ID and derive generation-0 authentication and
   key-agreement keys;
3. append `did.created` with role `rendezvous`;
4. create or reuse one or more vault-scoped mediated/direct routes and
   append `did.routesSelected`;
5. construct exact canonical `did.json`, store it as a blob and append
   `did.documentPrepared`;
6. append `did.documentSelected`;
7. publish the document provisionally through deployment-specific
   authenticated means and fetch the standard `did:web` resolution URL to
   verify exact bytes, hash and DID `id`;
8. for every mediated route, reconcile recipient registration using the now
   resolvable authentication method and append `did.routeRegistered` after
   success;
9. fetch the public document again and verify that it still matches the
   selected revision;
10. append `did.documentPublished` only after both publication verification
    and all selected mediated-route registrations succeed;
11. append `rendezvous.generationConfigured` with its ingress routes and
    relationship route; and
12. optionally append `did.disclosed` for a reusable OOB invitation or public
    profile.

The public DID belongs to the vault, not the runtime that served `did.json`.
Moving publication to another process or adding a server full replica does
not change the DID entity.

### 16.6 Initiate rendezvous

1. learn a peer rendezvous DID through a URL, QR code, directory or manual
   input;
2. create a contact and append `contact.peerDidAdded` for that public DID;
3. create one local relationship DID through section 16.4 and associate it
   with the contact;
4. write the `rendezvous/1.0/request` body and append `message.out` while
   offline if necessary;
5. later resolve the public DID, prepare the exact encrypted package and
   submit it under ordinary delivery rules; and
6. continue retries until `accept`, decline, expiry or explicit hold.

The request's `from` is the local relationship DID. The public rendezvous DID
is only its `to` target.

### 16.7 Accept rendezvous

After a durable, authenticated `rendezvous/1.0/request`:

1. map the local decryption key generation to exactly one live rendezvous
   generation and verify that the receiving route is in its `ingressRoutes`;
2. verify expiry and policy;
3. derive deterministic relationship, local DID and contact IDs exactly as
   specified by `rendezvous/1.0`;
4. derive the relationship DID's generation-0 keys and construct its peer DID
   using the generation's fixed `relationshipRoute`;
5. append, preferably through one `appendAll`, `contact.created`, one
   `contact.attached` for the bootstrap channel, one `contact.attached` for
   the future relationship channel, `did.created`, `contact.useDid` and
   `relationship.established`;
6. reconcile recipient registration for the new peer DID when mediated;
7. derive the deterministic acceptance effect and append `message.out`;
8. prepare `accept` from the new pairwise DID with the byte-stable
   `from_prior` profile in `rendezvous/1.0`, signed by the public generation's
   authentication key; and
9. retry until the peer sends a valid message to the new DID or policy stops.

Several replicas may run these steps. Equal deterministic statements are
harmless; inconsistent statements create a conflict and MUST stop automatic
acceptance.

### 16.8 Send an ordinary message

The synchronous public send operation of a full vault runtime:

1. writes attachment blocks;
2. writes the stored message document;
3. appends `message.out`; and
4. returns `mid` and `wireId`.

It performs no required network operation.

Any replica may later:

1. fold the target contact/channel;
2. choose the current relationship DID and authenticated peer key;
3. append peer/channel observations when changed;
4. construct and encrypt the innermost DIDComm message;
5. store exact encrypted-envelope bytes;
6. append `message.prepared`;
7. submit directly or through Routing 2.0 using `packageId` as `forward.id`;
8. append `delivery.submitted` or `delivery.failed`; and
9. retry until ultimate acknowledgment or unresolved hold.

Concurrent replicas may perform these steps. Stable IDs and duplicate rules
provide correctness; a lease is only an optimization.

Ordinary traffic after rendezvous uses the contact's current relationship
DID. It does not fall back to the public DID merely because the pairwise
transport is temporarily unavailable.

### 16.9 Receive a message

For every pickup or direct delivery:

1. authenticate, decrypt and validate the innermost message;
2. derive channel, deterministic `mid` and `contentHash`;
3. verify/lift attachments and write retained blocks;
4. write the stored message document;
5. append `message.in` durably together with applicable `channel.firstSeen`,
   `peer.resolved`, `peer.transitioned`, the contact attachment required by a
   scoped transition, and lifted profile observations;
6. only then ACK this replica's mediator delivery;
7. schedule idempotent automatic effects, including rendezvous acceptance;
   and
8. send ultimate ACK after the durable inbound commit when requested.

The observations in step 5 SHOULD use one `appendAll`. A backend without an
atomic batch appends `message.in` first, then the derived observations; an
observation MUST NOT be the sole durable evidence for a message that was not
committed.

A crash before step 5 leaves the mediator delivery pending. A crash after
step 5 and before step 6 causes redelivery and another duplicate event or an
idempotent recognition of the same logical message.

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

1. Every locally appended event has `author == local replica_id`.
2. A full replica on a server follows the same event and pickup semantics as
   any other full replica; no separate host identity is required.
3. A remote client without the seed is not an event author.
4. A mediation created by one replica is derivable and usable by another.
5. Retiring a replica changes future delivery policy but does not invalidate
   its events or revoke the seed.
6. A send commits `message.out` and blobs with all networking disabled.
7. `message.out` does not require a resolved peer key or reachable mediator.
8. Retrying one package preserves byte-identical envelope and package ID.
9. Repacking preserves `mid` and `wireId` while changing `packageId`.
10. HTTP success produces `delivery.submitted`, never
    `delivery.acknowledged`.
11. A valid ultimate ACK stops every package retry for the outbound message.
12. More than one replica receiving one message derives the same inbound
    `mid` and folds to one logical message.
13. Same inbound MID with different content hash is an integrity conflict and
    triggers no automatic effect.
14. Pickup ACK is sent only after durable `message.in` and retained blobs.
15. Concurrent automatic replies derive one semantic `mid` and wire ID.
16. An imported or synchronized outbound is not automatically held.
17. Releasing a hold names the exact hold event and is independent of
    wall-clock ordering.
18. `did.routeRegistered` is treated as historical observation; reconnect
    still queries and reconciles mediator state.
19. A relationship DID and a rendezvous DID may select the same reusable
    mediated route and receive the same per-replica mailbox fan-out.
20. A public DID, its document revision and its selected route remain
    vault-scoped when publication moves to another runtime.
21. A `did:web` document is considered current only after fetched bytes match
    the selected revision and DID `id`.
22. A reusable OOB disclosure contains a rendezvous DID and no relationship
    DID.
23. A rendezvous request can be durably queued before resolving the public
    DID.
24. Two replicas accepting the same rendezvous request derive the same
    relationship ID, contact ID, local DID entity, bootstrap and relationship
    channel attachments, and logical acceptance.
25. Retrying one rendezvous request through another ingress route in the
    same public key generation converges, while reusing its wire ID with a
    different key generation is a conflict and creates no automatic
    relationship.
26. The acceptance contains valid `from_prior` from the public DID to the new
    relationship DID.
27. Processing `peer.transitioned` attaches the new authenticated channel
    and changes the current peer DID only in its named contact component.
28. Two contacts may transition from the same public DID to different pairwise
    DIDs without being merged.
29. Established pairwise traffic remains usable when the public web publisher
    is unavailable.
30. A late replica can replay unexpired mediator messages independently of
    other replicas' ACKs.
31. A retired or acknowledged prepared package no longer pins its encrypted-
    envelope blob.
32. Erasure is checked before block presence.
33. Missing non-erased bytes are never displayed as deletion.
34. Contact merge is an undirected connected component and is order-
    independent.
35. Multiple current relationship ends are surfaced instead of resolved by
    LWW.
36. Restoring without `local/` creates a new replica that resumes mediation,
    pickup, sync, web-publication reconciliation and outbox work.
37. Extension purge removes the extension store but leaves its lifecycle
    events.
38. Shuffling all events does not change any fold result.
39. A configured sync-store DID survives folder export and can be resolved by
    a restored replica without local options.
40. Retiring one sync configuration stops work against it without deleting
    remote ciphertext or blocking another usable store.
41. No correctness rule depends on one replica remaining online.
42. A rendezvous generation may use one set of public ingress routes and a
    different relationship route without exposing replicas or changing the
    public-to-pairwise handoff.
