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

On unlock, the client derives the `anchor` key from the seed and MUST
verify the DID before using the vault.

### 3.2 Single seed

One seed derives every vault-controlled asymmetric key. The current key
profile uses HKDF-SHA-256 with the `@estoc/keystore` v3 domain separation.
The same seed and same key name always produce the same key material.

Reserved names are:

| name | purpose |
| --- | --- |
| `anchor` | immutable identity anchor |
| `mediation/<id>/me` | DIDComm identity for one mediation arrangement |
| `did/<id>` | communication DID handed to peers |
| `sync/account` | shared authenticated account used by `vault-sync/1.0` |

`<id>` is a canonical UUIDv7. Key names are never renamed or reused.
They do not encode a contact or replica.

The fixed symmetric sync keys are derived as specified by
`vault-sync/1.0`; they are not represented as event entities.

### 3.3 Replica IDs and authors

Each writable local incarnation has one canonical UUIDv7 `replica_id`.
Every event it appends has:

```text
event.author = local replica_id
```

No creation event is required. The earliest event by an author may be of
any type.

A portable restore or sync bootstrap mints a new replica ID. An exact
move may preserve one only when the old writer is gone. If two writable
copies share an author, `event-store.md` detects a fork when their event
sets meet.

### 3.4 Entity IDs

Unless a rule below says deterministic, locally created entity IDs are
canonical UUIDv7.

The following fixed UUIDv5 namespaces are used for cross-replica
idempotency:

```text
inbound message:  689dff5c-d975-5725-898f-267e97e909c1
automatic contact: b1942994-48f8-58ff-9117-0df20f60c150
automatic MID:     3e4f042b-9cb7-568c-a065-59c7c0d2f5ba
automatic wire ID: 1bbea408-beff-5583-b67b-5b51393b7e51
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
services. `peer.resolved` and `peer.rotated` connect channels and DIDs in
the identity graph.

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
    "myKey": "did/019b2a45-8381-793f-943c-f5d806fd5ca2",
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

## 5. Mediation and our DIDs

Mediation arrangements and communication DIDs belong to the vault. Their
meaning never depends on the event author.

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
arrangement. `me.key` MUST use the arrangement ID and `me.did` MUST match
the seed-derived key.

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

This is the durable observation that the mediator granted the
arrangement and returned `routingDid`.

More than one distinct routing DID for one arrangement ID is a conflict.
The runtime MUST NOT guess which grant is authoritative; it establishes a
new arrangement or obtains an explicit current answer from the mediator.

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

This is the user's or policy's choice of preferred mediation for newly
minted communication DIDs. The latest event by canonical order wins.

Selection does not stop old arrangements from receiving. Any mediation
still referenced by a live communication DID remains required.

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

Retirement is terminal for the arrangement ID. A procedure SHOULD retire
or rotate every live DID that depends on it first. If a retired mediation
is still referenced by a live DID, the fold reports a routing
configuration conflict rather than silently changing the DID.

### 5.2 DID events

#### `did.minted`

```json
{
  "type": "did.minted",
  "blobs": [],
  "data": {
    "key": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "did": "did:peer:4zQm...",
    "routingDid": "did:peer:2.Ez...",
    "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c"
  }
}
```

`key` MUST be `did/<uuidv7>`. `did` MUST be the DID deterministically
constructed from the seed-derived key and `routingDid`. The named
mediation must have a matching grant.

This event says the vault created the DID. It does not say the mediator
currently has the recipient registration or that anyone has seen the
DID.

#### `did.registered`

```json
{
  "type": "did.registered",
  "blobs": [],
  "data": {
    "key": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "registrationId": "019b2a55-bae7-705a-baea-45782de39809"
  }
}
```

This is an observation that the mediator accepted the corresponding
recipient-control registration defined by `replica-mediation/1.0`.

It is not permanent proof of current mediator state. Every connection
queries and reconciles the mediator from the converged vault fold.

#### `did.unregistered`

```json
{
  "type": "did.unregistered",
  "blobs": [],
  "data": {
    "key": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "registrationId": "019b2a55-bae7-705a-baea-45782de39809"
  }
}
```

This observes successful removal of that exact registration generation.
A delayed removal for an old `registrationId` does not cancel a later
registration.

#### `did.published`

```json
{
  "type": "did.published",
  "blobs": [],
  "data": {
    "key": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "as": "oob",
    "uses": "one",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb",
    "goal": "Write to Alice"
  }
}
```

`as` is one of:

```text
oob
profile
direct
```

`uses` is `one` or `many`. `oobId` is REQUIRED when `as == "oob"` and
absent otherwise. `goal` is optional user-visible context.

This event is the permanent record that the DID was exposed for a
purpose. Publishing requires a successful or currently verified
recipient registration first.

#### `did.retired`

```json
{
  "type": "did.retired",
  "blobs": [],
  "data": {
    "key": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "because": "contact-deleted"
  }
}
```

Retirement is terminal for the key name. A retired DID is removed from
the desired mediator recipient set and is not chosen for new outbound
messages. Its events and past channels remain history.

An envelope that still arrives for a retired key may be durably recorded
before policy rejects further interaction; retirement is not retroactive
erasure.

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
`contact.merged` edges.

### 7.1 Contact IDs

A user-created contact uses a UUIDv7 `cid`.

An automatic handler adopting an authenticated channel MUST use:

```text
cid = UUIDv5(
  b1942994-48f8-58ff-9117-0df20f60c150,
  RFC8785(["v1", myKey, peerKey])
)
```

This prevents two replicas from creating permanent duplicate contacts
for the same channel. `peerKey == null` MUST NOT be automatically adopted
without an application-specific authenticated discriminator.

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

`because` is `user` or `automatic`. An automatic event also SHOULD carry
its deterministic `effectId`.

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

#### `contact.useKey`

```json
{
  "type": "contact.useKey",
  "blobs": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "key": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "because": "minted"
  }
}
```

This outbound preference associates one of our communication DIDs with
the contact. It says nothing about an authenticated peer channel.

#### `contact.attached`

```json
{
  "type": "contact.attached",
  "blobs": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "because": "invitation",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb"
  }
}
```

`because` is `invitation`, `accepted`, `automatic` or `manual`.
`oobId` is present when the attachment consumed an invitation.

This is the explicit decision that an authenticated channel belongs to a
contact. It is not inferred from a DID claim alone.

#### `contact.detached`

```json
{
  "type": "contact.detached",
  "blobs": [],
  "data": {
    "cid": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa"
  }
}
```

The latest attach/detach decision for the exact `(cid, channel)` by
canonical order decides whether the edge is live.

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

This is an undirected identity edge. The fold takes connected components
of all merge edges. Direction is descriptive only. Cycles and concurrent
opposite-direction merges are harmless.

There is no unmerge in version 3. The recovery for a mistaken merge is to
detach channels and create or attach the desired contact.

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

This is a permanent tombstone for one contact ID. Deleting a merged
contact appends one tombstone for every currently known member of the
component. A member learned later requires another tombstone.

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
- `packageId` identifies one exact encrypted inner envelope and is used
  as Routing 2.0 `forward.id`.
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
    "myKey": "did/...",
    "peerKey": "..."
  }
}
```

A channel target is used for an unattributed but authenticated peer or a
protocol reply that must use a particular channel. A peerKey-null channel
MUST NOT be used for an authenticated reply.

`thid`, `pthid` and `effectId` are present with JSON null when unused.
`blobs` MUST equal the distinct ordered set consisting of `body` followed
by `attachments`.

Appending this event is the complete public send operation. It MUST NOT
require network access, DID resolution, a current socket or a currently
reachable mediator.

More than one `message.out` event with the same `mid` is allowed only
when every semantic field is identical. Different content under one
`mid`, or one `wireId` used by different outbound intent content, is a
message integrity conflict.

### 9.3 `message.prepared`

```json
{
  "type": "message.prepared",
  "blobs": ["bafy...encrypted-envelope"],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "recipientDid": "did:peer:4zQm...",
    "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "plaintextHash": "YWJjZGVm...",
    "envelope": "bafy...encrypted-envelope",
    "envelopeHash": "YWJjZGVm..."
  }
}
```

This materialization makes one exact normalized inner DIDComm encrypted
envelope recoverable by every replica.

Requirements:

- the inner plaintext `id` is `wireId`;
- `plaintextHash` is unpadded base64url SHA-256 of the RFC 8785 canonical
  innermost plaintext;
- every package for one `mid` uses the same canonical plaintext and
  authenticated sender key;
- the message requests ultimate acknowledgment as required by
  `distributed-delivery/1.0`;
- the envelope blob contains exact normalized encrypted-message bytes;
- `envelopeHash` is unpadded base64url SHA-256 of those bytes;
- `packageId` is a UUIDv7 and the outer Routing 2.0 `forward.id`;
- every retry of this package uses the same envelope bytes; and
- re-encryption for another peer key or packing parameter creates a new
  package ID while preserving `mid` and `wireId`.

More than one active package may exist for one message during a rotation
or replica race.

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

`replacement` is optional. Retirement stops automatic submission of that
package and releases its encrypted-envelope root when no other event
holds it. It does not affect the logical message or another package.

### 9.5 `delivery.submitted`

```json
{
  "type": "delivery.submitted",
  "blobs": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "mediation": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "transport": "https",
    "status": 202
  }
}
```

This observation means only that a transport endpoint accepted the
package attempt. It never means the route existed, the mediator retained
the message, a replica picked it up or the ultimate peer committed it.

Any replica may append this observation. Concurrent submissions are
expected.

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

`hold` is the `eid` of one `delivery.held` event. A message is held while
at least one hold event for it has no release. Explicit references avoid
clock-order ambiguity.

### 9.9 `delivery.acknowledged`

```json
{
  "type": "delivery.acknowledged",
  "blobs": [],
  "data": {
    "mid": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "ackMid": "27c4471f-8937-501b-9ffb-a7eaeeebc178",
    "ackWireId": "21559fb4-1a9f-54b1-b8fa-1bf82700d365"
  }
}
```

This observation is appended only after an authenticated ultimate peer
message acknowledges `wireId` under `distributed-delivery/1.0`.
`ackMid` identifies the local inbound ACK message.

One valid acknowledgment stops automatic retry of every package for the
logical outbound message. Duplicate acknowledgment events are harmless.
Acknowledged means durable receipt by the peer vault, not read or accepted
by a business workflow.

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

The authenticated form intentionally omits `myKey`. Re-encrypting the
same canonical plaintext to another recipient key of this vault therefore
converges on one message. The anonymous form includes `myKey` because it
has no authenticated peer namespace.

This does not replace `wireId`. The two IDs remain distinct, and the
receiver preserves both.

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "blobs": ["bafy...body", "bafy...attachment"],
  "data": {
    "mid": "67e6118c-3fbd-5df6-bf4c-b99413d30b37",
    "wireId": "019b2a70-f225-721c-835f-67175be0667e",
    "contentHash": "YWJjZGVm...",
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
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
- `did` is the peer DID under which the authenticated peer key was
  resolved for this message, or null when none is available;
- `thid`, `pthid` and `signedBy` are present with null when absent;
- the event `author` identifies the receiving replica;
- `mediation` and `deliveryId` are null for a direct transport that has
  no such value;
- `bytes` is the byte length of the canonical stored message document;
  and
- `blobs` is the distinct ordered set of `body` followed by
  `attachments`.

A replica appends the event only after all retained blobs are durable.
Only then may it acknowledge its mediator delivery.

### 10.3 Duplicate and conflict rules

For one inbound `mid`:

- equal `contentHash`, message metadata and retained roots are duplicate
  observations of one logical message;
- differences in `receivedVia` are expected replica/transport
  observations;
- for an authenticated message, differences in `myKey` are also expected
  when one retry reached another recipient key of this vault;
- different `contentHash` is an integrity conflict;
- a different `peerKey` or wire ID under the same authenticated MID, or a
  different `myKey` or wire ID under the same anonymous MID, is a
  derivation/implementation error; and
- a conflict suppresses automatic effects until surfaced or resolved by
  an application-specific decision.

The message fold displays one logical message with all `receivedVia`
observations. Event authorship may show which replicas durably received
it, but does not create separate conversation messages.

Anonymous messages have `peerKey == null`; an attacker can intentionally
reuse a wire ID. Applications SHOULD impose stricter replay and automatic
handling policy for them.

### 10.4 Pickup versus ultimate acknowledgment

A Message Pickup `messages-received` acknowledgment is not a vault event.
It is local mediator state for one replica and is sent after the durable
`message.in` append.

The ultimate peer ACK is an end-to-end application message. It is itself
recorded as `message.in` and may produce `delivery.acknowledged` events
for outbound wire IDs named in its `ack` header.

## 11. Peer and profile observations

All events in this section carry a complete channel key.

### 11.1 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "blobs": [],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "did": "did:web:alice.example",
    "keys": ["did:key:z6LS...", "did:key:z6Mk..."],
    "service": "did:peer:2.Ez..."
  }
}
```

The event says the authenticated `peerKey` was actually found under
`did` when resolving or unpacking this channel. Only the key that the
envelope proved creates an identity-graph edge. Other entries in `keys`
are context and MUST NOT be treated as proof of control.

A client SHOULD append only when the latest equivalent resolution differs,
but duplicate observations are harmless.

### 11.2 `peer.rotated`

```json
{
  "type": "peer.rotated",
  "blobs": [],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "from": "did:peer:4zQm...old",
    "to": "did:peer:4zQm...new",
    "fromPrior": "eyJ...",
    "mid": "689d..."
  }
}
```

This event is lifted only from a valid DIDComm `from_prior` statement in
the named inbound message. It joins the old and new DIDs in the identity
graph. The JWT is evidence, not a blob reference.

### 11.3 `profile.nameClaimed`

```json
{
  "type": "profile.nameClaimed",
  "blobs": [],
  "data": {
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "wireId": "019b...",
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
    "myKey": "did/019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "peerKey": "k3j9n0m4x6q2w7c8v5p1d8s0fa",
    "wireId": "019b..."
  }
}
```

This observes that our profile was sent on the channel. Duplicate lifted
observations are harmless.

## 12. Automatic effects

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
`effectId`.

- Automatic contacts use the deterministic contact rule in section 7.
- Automatic outbound messages derive stable `mid` and `wireId` values in
  section 9.
- Handler-produced events SHOULD include `effectId` when their schema
  permits diagnostics and duplicate recognition.
- An external system call MUST use `effectId` as its idempotency key or
  explicitly accept at-least-once side effects.

There is no distributed exactly-once claim. A generic effect lease may
reduce duplicate work but MUST NOT be required for correctness.

## 13. Folds

All folds accept events in any order and are deterministic over the set.
Canonical order is used only where stated.

### 13.1 Replica fold

For each replica ID seen as an author, label target or retirement target:

- `label` is the latest `replica.label` by canonical order;
- `retired` is true if any `replica.retired` names it;
- `firstEventAt` is the earliest accepted event authored by it; and
- `lastEventAt` is the latest accepted event authored by it.

Retirement does not mark later events suspect or invalid. The fold may
show them for diagnostics because a delayed sync and a hostile holder of
the shared seed are indistinguishable at this layer.

Mediator-reported active registration is live remote state and is joined
by the runtime, not recorded as authority in this fold.

### 13.2 Mediation fold

For each mediation ID:

- exactly one consistent `mediation.created` defines mediator and key;
- one consistent `mediation.granted` makes it usable;
- any `mediation.retired` makes it terminal; and
- conflicting create or grant values make it unusable and visible as a
  conflict.

The preferred mediation is the latest `mediation.selected`. If it is
missing, ungranted, retired or conflicted, preferred is null and policy
must select another.

The **required receiving set** is every usable mediation that is either:

- preferred; or
- referenced by a non-retired `did.minted`.

Every full replica attempts replica registration and pickup on every
reachable mediation in this set.

### 13.3 Sync-store fold

For each sync configuration ID:

- exactly one consistent `sync.configured` defines its store DID;
- any `sync.retired` makes the configuration terminal; and
- conflicting configuration values make it unusable and visible as a
  conflict.

The preferred sync store is the latest `sync.selected` target that is
configured, non-retired and non-conflicted. If no preferred store is
usable, local commits continue and sync is offline. A runtime MAY also
mirror to other usable configurations, but failure of one store MUST NOT
block another.

Remote `store_id`, server sequence cursors, upload tickets and endpoint
caches are local state. They never enter this fold.

### 13.4 Our-DID fold

For each key name:

- `minted` is its one consistent `did.minted` event;
- `retired` is true if any `did.retired` names it;
- `published[]` contains all publication observations in canonical order;
- registration history is grouped by `(mediation, registrationId)`; and
- `usedBy[]` is the contact components with a live `contact.useKey` or
  invitation attachment under it.

The desired mediator recipient set is every minted, non-retired DID under
a required receiving mediation. `did.registered` and `did.unregistered`
are audit observations only; the runtime queries the mediator and
reconciles desired state.

A key with inconsistent seed-derived DID, routing DID or mediation is an
integrity conflict.

### 13.5 Identity graph and channel attribution

Build a graph whose nodes are:

- authenticated channels with `peerKey != null`; and
- peer DIDs.

Edges are:

- `peer.resolved`: exact channel to the DID under which its authenticated
  peer key was found;
- `peer.rotated`: old DID to new DID; and
- no edge for merely listed document keys.

Exclude mediation channels from the contact graph.

For a channel, collect every live `contact.attached` whose channel lies in
its graph component, then collapse contact IDs by `contact.merged`:

- none: unattributed;
- one contact component: attributed to it;
- several: multi-valued attribution conflict.

The fold never attributes an anonymous `peerKey == null` channel through
the graph.

### 13.6 Contact fold

Contact merge edges form undirected connected components. The reported
representative is the lexicographically smallest non-deleted `cid`; if
all are deleted, the smallest `cid` is retained as the hidden tombstoned
representative.

For one component:

- deleted when every known member has a `contact.deleted` tombstone;
- `petname` is latest by canonical order;
- each flag is latest by canonical order;
- `claimedName` is latest `profile.nameClaimed` across attributed
  channels;
- `attached[]` is every live attach edge;
- `keys[]` is every live `contact.useKey` plus invitation-implied use;
- `theirDids[]` is the peer-DID graph component, with unresolved multiple
  ends surfaced;
- `writeTo[]` is every non-conflicted, non-retired channel/DID route that
  can currently be prepared; and
- `thread` is the logical message union described below.

A fold MUST NOT select one of several current peer-DID ends merely by
clock order. Rotation ambiguity is a visible conflict.

### 13.7 Inbound message fold

Group `message.in` events by `mid`.

For each group:

- equal semantic skeleton and `contentHash` is one logical message;
- collect every distinct receiving channel, `receivedVia` and author
  observation;
- different `contentHash` or semantic skeleton is an integrity conflict;
- erasure state is applied before blob presence; and
- automatic effects are disabled for a conflict.

A thread contains the logical message once, positioned by the earliest
canonical `message.in` observation unless an application-specific
protocol defines another display time.

### 13.8 Outbound message and delivery fold

Group `message.out` by `mid`. Multiple identical intent events are one
logical outbound message. Different intent content under one `mid` is a
conflict.

For a valid outbound message:

- `packages[]` is every consistent `message.prepared` by `packageId`;
- all packages MUST agree on `wireId`, `plaintextHash` and `myKey`, or the
  logical outbound message is conflicted;
- a package is inactive after `message.packageRetired`;
- unresolved holds are `delivery.held` events not named by any
  `delivery.released`;
- `acknowledged` is true if any valid `delivery.acknowledged` names the
  message's wire ID on an allowed channel continuation;
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

Any full replica may process a valid queued or retryable message.
Authorship never limits outbox ownership. Import or synchronization does
not create a hold.

### 13.9 Invitation fold

An OOB publication with `uses == "one"` is open when:

- its DID is not retired; and
- no live `contact.attached` names its `oobId`.

It is taken by the resulting contact component. Concurrent valid takes
are visible; deterministic automatic contact IDs prevent duplicate takes
of the same authenticated channel but cannot prevent distinct peers from
using a copied one-use invitation.

A `uses == "many"` publication remains open until its DID is retired.

### 13.10 Extension fold

For each `ext`:

- installed if a consistent `extension.installed` exists;
- removed if any `extension.removed` exists after installation;
- purged if any `extension.purged` exists; and
- purged is terminal.

The application applies every pending purge before opening or executing
extensions.

## 14. Erasure and collection

### 14.1 `message.erased`

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

### 14.2 Reading content

For a message root:

1. if any `message.erased` for the message names the root, state is
   **erased** regardless of block presence;
2. otherwise, if every required block is present, content is available;
3. otherwise, if the message or object type explicitly permits partial
   trees, state may be **not yet fetched**; and
4. otherwise state is **missing or damaged**.

Missing bytes MUST NOT be displayed as intentional deletion.

### 14.3 Held roots

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

### 14.4 No replica-local eviction event

Version 3 does not represent local body eviction as a portable event.
A local storage policy that deletes a non-erased retained block makes the
copy incomplete; `vault-sync/1.0` or another replica may restore it.
Such a local absence never authorizes another replica to collect bytes.

## 15. Procedures

These procedures define required ordering. Implementations may combine
steps transactionally but may not reverse the durability boundaries.

### 15.1 Open a writable replica

1. verify folder/store version and anchor;
2. unlock or obtain the seed;
3. load or mint local `replica_id` and store generation;
4. fold extension lifecycle and dispose purged stores;
5. fold configured sync stores and reconcile each reachable usable store;
6. refold portable state;
7. if this replica is retired, mint a new local replica context;
8. derive every required mediation account;
9. register this replica and reconcile recipient registrations;
10. drain per-replica pickup queues;
11. start live delivery, periodic sync and retry workers independently.

Failure of one mediator or sync store MUST NOT prevent local vault use.

### 15.2 Establish mediation

1. append `mediation.created` before the network request;
2. derive its shared account key;
3. perform Coordinate Mediation;
4. on grant, append `mediation.granted`;
5. register the local replica through `replica-mediation/1.0`; and
6. append `mediation.selected` when policy chooses it for new addresses.

A network failure after step 1 leaves a retryable intent, not a half
identity.

### 15.3 Configure a sync store

1. mint a configuration ID and append `sync.configured` before required
   network work;
2. resolve the store DID and establish the shared sync account;
3. run `vault-sync/1.0` hello and full inventory;
4. publish missing root, blocks and events; and
5. append `sync.selected` when policy chooses it as preferred.

A failed store remains configured and retryable until explicitly retired.
Folder restore can discover it from the event set; seed-only bootstrap
still requires an external locator for the first contact.

### 15.4 Mint and publish a communication DID

1. choose the selected usable mediation;
2. mint a UUIDv7 DID key name;
3. derive the DID and append `did.minted`;
4. reconcile recipient registration with control proof;
5. append `did.registered` after success;
6. only then expose the DID and append `did.published`.

If publication occurs through another atomic application operation, that
operation must still never expose an unregistered route as successful.

### 15.5 Send a message

The synchronous public send operation:

1. writes attachment blocks;
2. writes the stored message document;
3. appends `message.out`; and
4. returns `mid` and `wireId`.

It performs no required network operation.

Any replica may later:

1. fold the target contact/channel;
2. resolve the current peer DID and key;
3. append peer/channel observations when changed;
4. construct and encrypt the innermost DIDComm message;
5. store exact encrypted-envelope bytes;
6. append `message.prepared`;
7. submit Routing 2.0 `forward` using `packageId` as `forward.id`;
8. append `delivery.submitted` or `delivery.failed`; and
9. retry until ultimate acknowledgment or unresolved hold.

Concurrent replicas may perform these steps. Stable IDs and duplicate
rules provide correctness; a lease is only an optimization.

### 15.6 Receive a message

For every pickup or direct delivery:

1. authenticate, decrypt and validate the innermost message;
2. derive channel, deterministic `mid` and `contentHash`;
3. verify/lift attachments and write retained blocks;
4. write the stored message document;
5. append `channel.firstSeen`, `peer.resolved`, `peer.rotated` or lifted
   profile events when applicable;
6. append `message.in` durably;
7. only then ACK this replica's mediator delivery;
8. schedule idempotent automatic effects; and
9. send ultimate ACK after the durable inbound commit when requested.

A crash before step 6 leaves the mediator delivery pending. A crash after
step 6 and before step 7 causes redelivery and another duplicate event or
an idempotent recognition of the same logical message.

### 15.7 Retire a replica

1. append `replica.retired` for the target;
2. synchronize the event;
3. every active replica reconciles retirement to every shared mediation
   account; and
4. labels and historical events remain.

This procedure does not secure a stolen seed. Security recovery requires
root or communication-key rotation outside `replica-mediation/1.0`.

### 15.8 Erase a message

1. fold every root currently retained by the logical message and its
   prepared packages;
2. append one or more `message.erased` events naming the requested roots;
3. refold held roots; and
4. call blob collection.

Late duplicate observations may introduce another event retaining the
same logical roots. A replica that observes an existing erase MUST append
an equivalent erase for newly learned roots of that message before those
roots are considered intentionally released.

### 15.9 Delete a contact

1. append `contact.deleted` for every currently known member of the
   contact component, preferably through `appendAll`;
2. for every message exactly attributed to the component, append erases
   for body, attachment and prepared-envelope roots required by policy;
3. retire one-use communication DIDs exclusively associated with the
   deleted component;
4. reconcile recipient removal; and
5. collect unheld blocks after grace.

A later merge cannot revive a tombstoned member. A newly discovered
component member or late message requires the same idempotent cleanup
procedure.

## 16. Merge, synchronization and restore

### 16.1 Event merge

Merge is event-store union by `eid`. It never:

- rewrites an event;
- removes another replica's decision;
- treats another author as read-only history;
- creates `delivery.held` because of authorship; or
- adopts a segment as opaque state.

After merge, every fold is recomputed from the union.

### 16.2 Blob merge

After event union, copy only valid absent blocks reachable from roots held
by the merged fold. An erased relation does not revive merely because an
older source still has the bytes.

Missing non-erased bytes remain an integrity/availability condition and
may be repaired from another replica or `vault-sync/1.0`.

### 16.3 Replica synchronization

`vault-sync/1.0` exchanges encrypted immutable root, event and block
objects. It does not synchronize:

- local replica selection;
- mediator pickup acknowledgments;
- local holds or retries unless they are vault events;
- caches, trace or sockets; or
- human-readable folder paths.

Push lowers latency. Full inventory anti-entropy provides correctness.

### 16.4 Restore

A portable folder restore or sync bootstrap creates a new local replica
ID. The restored copy may derive every mediation and communication key,
register itself with each required mediator, replay retained mailbox
messages and continue every non-held, non-acknowledged outbound message.

No old replica must be online. Mediator retention still bounds messages
that were never committed to any vault replica.

### 16.5 Forked author

If two writable copies accidentally preserve the same local replica ID,
previously unseen same-author events cause `ForkedAuthor`. One copy mints
a new local replica ID and retries merge. Existing events under the old
author remain unchanged.

## 17. Privacy and security boundaries

- All full replicas share one seed and equal communication authority.
- Replica IDs and event authors are operational labels, not credentials.
- Retiring a replica does not revoke an extracted seed.
- The readable folder contains plaintext retained message content and
  attachments unless the surrounding storage encrypts it.
- `replica-mediation/1.0` stores only encrypted inner DIDComm envelopes
  and routing/delivery metadata at the mediator.
- `vault-sync/1.0` stores client-side encrypted opaque objects and does
  not receive event types, CIDs or author IDs in plaintext.
- The mediator may observe mediation account, recipient route,
  ciphertext size, replica ID, arrival, pickup, ACK, expiry, IP and
  traffic timing.
- Ultimate ACKs reveal durable-receipt timing to the peer but not which
  replica received first.
- Event authorship does not authenticate one full replica against another
  malicious holder of the seed.

## 18. Versioning

These event meanings belong to vault version 3. A version-3 reader may
preserve unknown event types but MUST validate every known type according
to this document.

Compatible additions within version 3 may introduce a new event type or
an explicitly optional payload field whose absence has a fixed meaning.
Changing the meaning of an existing field, fold, deterministic ID,
erasure rule or key derivation requires a new vault version.

There is no migration requirement from an earlier event vocabulary.

## 19. Required conformance cases

1. Every locally appended event has `author == local replica_id`.
2. No separate host identity or replica-creation event is required.
3. A mediation created by one replica is derivable and usable by another.
4. Retiring a replica changes future delivery policy but does not
   invalidate its events.
5. A send commits `message.out` and blobs with all networking disabled.
6. `message.out` does not require a resolved peer key or reachable
   mediator.
7. Retrying one package preserves byte-identical envelope and package ID.
8. Repacking preserves `mid` and `wireId` while changing `packageId`.
9. HTTP success produces `delivery.submitted`, never
   `delivery.acknowledged`.
10. A valid ultimate ACK stops every package retry for the outbound
    message.
11. More than one replica receiving one message derives the same inbound
    `mid` and folds to one logical message.
12. Same inbound MID with different content hash is an integrity
    conflict and triggers no automatic effect.
13. Pickup ACK is sent only after durable `message.in` and retained blobs.
14. Concurrent automatic contact adoption derives one `cid`.
15. Concurrent automatic replies derive one semantic `mid` and wire ID.
16. An imported or synchronized outbound is not automatically held.
17. Releasing a hold names the exact hold event and is independent of
    wall-clock ordering.
18. `did.registered` is treated as historical observation; reconnect
    still queries and reconciles mediator state.
19. A late replica can replay unexpired mediator messages independently
    of other replicas' ACKs.
20. A retired or acknowledged prepared package no longer pins its
    encrypted-envelope blob.
21. Erasure is checked before block presence.
22. Missing non-erased bytes are never displayed as deletion.
23. Contact merge is an undirected connected component and is
    order-independent.
24. A multi-ended peer rotation is surfaced instead of resolved by LWW.
25. Restoring without `local/` creates a new replica that resumes
    mediation, pickup, sync and outbox work.
26. Extension purge removes the extension store but leaves its lifecycle
    events.
27. Shuffling all events does not change any fold result.
28. A configured sync-store DID survives folder export and can be resolved
    by a restored replica without local options.
29. Retiring one sync configuration stops work against it without deleting
    remote ciphertext or blocking another usable store.
30. No correctness rule depends on one replica remaining online.
