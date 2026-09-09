# The Estoc vault events, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

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
whose complete envelope is defined by [event-store.md](event-store.md). Object CIDs and
retention semantics are defined by [dasl-objects.md](dasl-objects.md). A known event
type has a closed payload schema in version 3. The store itself validates
only the envelope; the vault layer validates the payload before append
and after ingest.

This document defines portable vault state. Socket state, pickup cursors,
retry timers, caches and traces are local state and do not appear here.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

Each domain places its event schemas and corresponding folds together.
Use the procedure column for the shared lifecycle and recovery operations.
Shared vocabulary is in [section 3](#identity-seed-and-key-names); cross-document rule ownership is listed in
the [suite guide](README.md#rule-ownership). The table is a navigation aid.

| Domain | Definitions and event schemas | Folds | Procedures |
| --- | --- | --- | --- |
| Identity and naming | [Identity, keys and identifier types](#identity-seed-and-key-names); [Identity label](#identity-label) | [Runtime author](#runtime-author-fold) | [Open runtime](#open-the-writable-full-runtime) |
| Mediation, DIDs and routes | [Key evidence and resolved documents](#message-keys-and-peer-evidence); [Mediation, DID and route events](#mediation-communication-dids-and-routes) | [Mediation](#mediation-fold); [Routes, DIDs and keys](#route-did-and-key-fold) | [Establish mediation](#establish-mediation); [Create DID](#create-a-communication-did); [Disclose address](#disclose-an-address) |
| Relationships and rotation | [Binding and both address transitions](#relationships-and-address-changes) | [Relationship and address index](#relationship-fold-and-address-index) | [Identity and binding policy](relationships.md#symmetric-relationship-identity); [Early privacy policy](relationships.md#early-private-address-policy-and-notifications); [Rotate local address](#rotate-a-local-relationship-address) |
| Contacts and profiles | [Contact events](#contacts); [Name claims](#profile-nameclaimed); [Sharing observations](#profile-shared) | [Relationship profiles](#relationship-profile-fold); [Contacts](#contact-fold) | [Delete contact](#delete-a-contact) |
| Messages and delivery | [Stored content](#stored-message-document); [Outbound events](#outbound-message-events); [Inbound events and witnesses](#inbound-message-events) | [Inbound execution](#inbound-message-and-execution-fold); [Outbound delivery](#outbound-message-and-delivery-fold) | [Send](distributed-delivery.md#send-an-ordinary-message); [Receive](distributed-delivery.md#receive-a-message); [Recover receipt](distributed-delivery.md#receive-recovery) |
| Invitations | [Disclosure](#disclosure) | [Invitation consumption](#invitation-fold) | [Discovery](relationships.md#out-of-band-discovery); [Receipt integrity](relationships.md#integrity-checks-and-durable-receipt) |
| Erasure and retention | [Erasure and held roots](#erasure-and-collection) | [Held-root rules](#held-roots) | [Erase message](#erase-a-message) |

<details>
<summary>Contents</summary>

- [1. Model](#model)
- [2. Principles](#principles)
- [3. Identity, seed and key names](#identity-seed-and-key-names)
- [4. Message keys and peer evidence](#message-keys-and-peer-evidence)
- [5. Mediation, communication DIDs and routes](#mediation-communication-dids-and-routes)
- [6. Relationships and address changes](#relationships-and-address-changes)
- [7. Contacts and profiles](#contacts)
- [8. Stored message document](#stored-message-document)
- [9. Outbound messages and delivery](#outbound-message-events)
- [10. Inbound messages and execution](#inbound-message-events)
- [11. Automatic effects](#automatic-effects)
- [12. Erasure and collection](#erasure-and-collection)
- [13. Procedures](#procedures)
- [14. Merge, synchronization and restore](#merge-synchronization-and-restore)
- [15. Privacy and security boundaries](#privacy-and-security-boundaries)
- [16. Versioning](#versioning)
- [17. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="model"></a>

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

<a id="principles"></a>

## 2. Principles

1. **Intent precedes effects.** A user-visible action is committed as an event
   and referenced objects before DNS, DID resolution, encryption or network
   submission begins.
2. **Observations carry their evidence boundary.** A peer observation carries
   the local and peer keys directly or through retained evidence references.
   Lifted profile facts reference their source messages. A mediator observation
   names the mediation arrangement that produced it.
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

<a id="14-folds"></a>

<a id="folds"></a>

### 2.1 Fold conventions

All folds accept events in any order and are deterministic over the set.
Canonical order is used only where stated.

<a id="identity-seed-and-key-names"></a>

## 3. Identity, seed and key names

<a id="vault-identity"></a>

### 3.1 Vault identity

The vault identity is the anchor DID in `vault_meta.anchor`. Two vaults are the
same identity exactly when their anchor DIDs are equal.

On unlock, the runtime derives the `anchor` key from the seed and MUST verify
the DID before using the vault. The anchor remains independent of rendezvous
and relationship communication DIDs. Disclosing a rendezvous DID or running
the full runtime on a server does not replace the anchor.

<a id="single-seed"></a>

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
`relationship.localTransitioned` under [section 6.5](#relationship-localtransitioned); rendezvous replacement
follows [relationships.md section 14](relationships.md#retry-replacement-and-address-rollover). There is no local
communication-key generation or key-generation selection. Store generations
retain their separate storage meaning.

TLS private keys, DNS credentials, ACME account keys and web deployment
credentials are not vault communication keys and MUST NOT be derived from
these names.

The `replica.*` event-type prefix is reserved for deferred [replica-mediation.md](replica-mediation.md);
the `sync.*` event-type and `sync/` key-name prefixes are reserved for deferred [vault-sync.md](vault-sync.md).

<a id="replica-ids-and-authors"></a>

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
[event-store.md](event-store.md) treats their divergent event sets as an author fork when they
meet. Network synchronization between different authors is deferred.

A remote client that does not hold the seed is not a full runtime, has no event
author and cannot turn a staged command into portable vault state by itself.

<a id="entity-ids-and-reproducible-uuidv5-namespaces"></a>

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
| `automatic-mid` | `8847bd57-5907-5bcd-9a71-d1e97cee3199` |
| `relationship` | `64990b5f-ad6e-5b22-98dd-9e455bb9378d` |
| `relationship-local-did` | `482afd96-31e8-5986-93c2-d65f5f742f3c` |
| `relationship-contact` | `ebbdeefb-e443-5e14-9cc9-2c468826de1c` |

A deterministic entity rule then computes:

```text
UUIDv5(estocNamespace(purpose), UTF8(RFC8785(name_array)))
```

`name_array` is the exact JSON array specified by that rule. RFC 8785
canonical UTF-8 gives unambiguous nulls, strings and field boundaries. A
runtime MUST derive and verify the namespace UUID from the URI above rather
than trusting a copied table constant. The table is a test vector, not a
second source of truth.

<a id="identifier-and-reference-vocabulary"></a>

### 3.5 Identifier and reference vocabulary

Vault-event payloads and application interfaces use the following names and
distinct validated types. The suffix describes what the value identifies;
it does not imply that every identifier has the same encoding or scope.
[Sections 3.4](#entity-ids-and-reproducible-uuidv5-namespaces), [4.1](#key-evidence) and the individual schemas own their derivation and validation.
[event-store.md](event-store.md) owns event identity; [dasl-objects.md](dasl-objects.md) owns content identity.

| Value | Type | Field names |
| --- | --- | --- |
| Vault message entity or inbound observation group | `MessageId` | `messageId`, `ackMessageId` |
| Received DIDComm plaintext ID | `WireMessageId` | `wireMessageId`, `ackWireMessageId` |
| One exact event | `EventId` | envelope `eventId` |
| Typed event reference | `EventReference<T>` | every payload field ending in `EventId`, including `sourceEventId`, `triggerEventId`, `addEventId` and resolution/binding/transition references |
| Contact / relationship | `ContactId` / `RelationshipId` | `contactId`, `fromContactId` / `relationshipId` |
| Local DID entity | `DidId` | `didId`, `localDidId`, `senderDidId`, `fromDidId`, `toDidId` |
| Route / mediation arrangement | `RouteId` / `MediationId` | `routeId`, `boundRouteId` / `mediationId` |
| One prepared package | `PackageId` | `packageId`, `replacementPackageId` |
| Scoped mediator delivery | `DeliveryId` | `deliveryId` |
| Relationship-scoped automatic execution | `ExecutionId` | `executionId` |
| Exact content bytes | `Cid` | `bodyCid`, `attachmentCids`, `documentCid`, `envelopeCid`, `dropCids`; generic object APIs use `cid` |
| Vault keystore name | `KeyName` | `localKeyName`, `me.keyName` |
| Complete canonical public-key value | `PublicKey` | `peerPublicKey` |
| DID string / verification-method DID URL | `Did` / `DidUrl` | `did`, `peerDid`, `presentedDid`, `longFormDid`, `fromDid`, `toDid` / `authenticationMethodIds`, `keyAgreementMethodIds` |

For every payload `*EventId`, `T` is the target event type fixed by the
referencing schema. `sourceEventId` is `EventReference<"message.in">` in
`profile.nameClaimed` and `EventReference<"message.out">` in `profile.shared`;
`triggerEventId` is `EventReference<"message.in">`, and `addEventId` is
`EventReference<"contact.peerDidAdded">`. The referencing schema also owns
presence and nullability; a nullable reference has the same typed non-null
value. Generic event-store APIs continue to use `EventId`.

Use the same entity noun for creation and later references: `did.created.didId`
and `did.disclosed.didId`, for example. Add a role prefix when needed, such as
`senderDidId`. Payloads do not abbreviate a contact ID as `cid`, or hide an
entity ID behind a bare `id`, `contact`, `relationship` or `mediation` field.
`cid` and `*Cid` always mean content addresses; `*Did` always means a DID
string, while `*DidId` means a local entity UUID. Arrays of references use the
plural suffix, such as `attachmentCids` and `localDidIds`; collections of view
records retain their own names and carry typed identifiers in each record.

The type distinction is part of the API contract. One possible TypeScript
representation is below; other languages may use equivalent nominal types.
`EventId` and `AuthorId` come from [event-store.md section 3](event-store.md#the-event), and `Cid` from
[dasl-objects.md section 6](dasl-objects.md#objectstore).

```ts
type EntityId<Kind extends string> = string & { readonly __entity: Kind };
type MessageId = EntityId<"message">;
type ContactId = EntityId<"contact">;
type RelationshipId = EntityId<"relationship">;
type DidId = EntityId<"did">;
type RouteId = EntityId<"route">;
type MediationId = EntityId<"mediation">;
type PackageId = EntityId<"package">;
type ExecutionId = EntityId<"execution">;
type SyncId = EntityId<"sync">; // Deferred configuration events only.
type ReplicaId = AuthorId;
type WireMessageId = string & { readonly __wireMessageId: unique symbol };
type DeliveryId = string & { readonly __deliveryId: unique symbol };
type KeyName = string & { readonly __keyName: unique symbol };
type PublicKey = string & { readonly __publicKey: unique symbol };
type Did = string & { readonly __did: unique symbol };
type DidUrl = string & { readonly __didUrl: unique symbol };
type EffectKey = string & { readonly __effectKey: unique symbol };
type EventReference<T extends string> = EventId & { readonly __eventType: T };
```

These types serialize as the existing validated strings, without wrapper
objects or type prefixes. Parsers and derivation functions produce them only
after the owning format checks. A cast is not validation. An event-reference
type records its required target type; missing evidence still defers and
incompatible evidence still conflicts under the referencing schema. It is
never proof that the target is available or valid. `effectKey` is the existing
derived idempotency key, not a keystore name or a cryptographic public key.

Message identity has three levels. `eventId` names one exact receipt or other
event; repeated receipt may create several event IDs with one `messageId`.
An inbound `messageId` names the key-scoped observation group; verified
cross-key variants may have different message IDs but one `executionId` in R.
An outbound `messageId` is also its plaintext `id`; no duplicate
`wireMessageId` field is stored on `message.out`. Inbound wire IDs have the
sender's scope and are stored separately. `packageId` names a prepared
package; `envelopeCid` addresses its bytes. `localKeyName`, `peerPublicKey`
and a verification-method DID URL are separate kinds of value and cannot be
substituted for one another.

This vocabulary applies to vault payloads, including deferred `replicaId`
and `syncId` fields. The event envelope's `author` and `roots`, serialized
local-file fields such as `replica_id`, and wire/protocol fields retain their
owner-defined names. In particular, DIDComm `id`, `body`, `attachments`,
`from`, `to`, `thid`, `pthid` and `kid` are unchanged; the stored message
document in [section 8](#stored-message-document) also retains its application-content shape. Producers
map vault fields to those protocol fields explicitly.

Namespace purpose strings, keystore paths, literal hash-transcript tags and
message-content serialization are fixed separately from field spelling.
Implementations MUST construct each specified derivation input, not serialize
an arbitrary renamed payload or API object as its substitute. The execution
transcript's literal `"relationship"` is specified in [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) even though payloads and runtime scope use `relationshipId`. Event
canonical bytes do use the current schema; any content hash of an event or
container therefore follows those actual bytes.

<a id="6-identitylabel"></a>

<a id="identity-label"></a>

### 3.6 `identity.label`

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

<a id="141-runtime-author-fold"></a>

<a id="runtime-author-fold"></a>

### 3.7 Runtime-author fold

Phase 1 expects exactly one active local `replica_id`. For each author seen in
the event set, the fold reports `firstEventAt` and `lastEventAt`. An author
fork is an event-store integrity condition, not a normal multi-writer merge.

<a id="message-keys-and-peer-evidence"></a>

## 4. Message keys and peer evidence

<a id="key-evidence"></a>

### 4.1 Key evidence

Each message or resolution retains the keys used for that observation or
package, directly or through its exact evidence references:

- `localKeyName` is the vault key name that decrypted or authenticated the
  message, or `null` when no local key participated.
- `peerPublicKey` is the complete authenticated or selected peer public key in the
  canonical encoding below, or `null` for an anonymous sender.

Each event schema defines its required fields and nullability. The keys
provide authentication, decryption and package evidence; they do not identify
a relationship or assign a contact. Anonymous input and mediator traffic may
retain key evidence without an application relationship.

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
Every deterministic ID or authorization check that uses a peer key uses this
exact string.

For an inbound observation it is the key that authenticated the message; for
an outbound package or resolution it is the selected recipient key. Selection
alone is not evidence of authenticated inbound traffic or remote receipt.

The executable key fixture used by this specification is X25519, public-key
codec `0xec` (unsigned-varint bytes `ec01`), with these 32 raw public-key bytes:

```text
0900000000000000000000000000000000000000000000000000000000000000
peerPublicKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
```

`message.in` and `message.prepared` store `localKeyName` and `peerResolutionEventId`, with
no `peerPublicKey` payload field. Their peer key is derived as
`peer.resolved(peerResolutionEventId).peerPublicKey`. For an anonymous
inbound only, null `peerResolutionEventId` yields null `peerPublicKey`; an unavailable or
invalid reference is deferred or conflicted, never treated as anonymous.
In this document and the delivery profile, a message or package's `peerPublicKey`
always means this derived value. `peer.resolved`, `relationship.peerTransitioned`
and ACK observations retain their explicit keys. Profile observations instead
reference their source message under [sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared).

`message.in.presentedDid` preserves the wire spelling, and
`peer.resolved.presentedDid` preserves the spelling used for resolution.
First-disclosure validation and recovery use this retained evidence. A
relationship's local and peer histories identify its authorized keys under
[section 6.6](#relationship-fold-and-address-index); rotation may change those keys while preserving R. Equal key
values under different DIDs do not supply relationship identity or a contact
assignment. An observation awaiting relationship verification keeps its key
evidence without provisional scope.

<a id="mediation-key-evidence"></a>

### 4.2 Mediation key evidence

Traffic between the vault and a mediator uses a local key beginning with:

```text
mediation/
```

These observations belong to the mediation fold, not application
relationships or contact/profile projections.

<a id="11-peer-and-profile-observations"></a>

<a id="peer-and-profile-observations"></a>

<a id="43-peer-and-profile-observations"></a>

<a id="resolution-observations"></a>

### 4.3 Resolution observations

Resolution observations retain exact cryptographic evidence. Peer-transition
observations follow the same rule in [section 6.4](#relationship-peertransitioned);
profile observations name one relationship and their source message in
[sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared). These facts remain
distinct from contact assignments and local DID entities.

<a id="111-peerresolved"></a>

<a id="peer-resolved"></a>

### 4.4 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "roots": [
    "bafkrei...resolved-did-document"
  ],
  "data": {
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerPublicKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "presentedDid": "did:web:bob.example",
    "did": "did:web:bob.example",
    "documentCid": "bafkrei...resolved-did-document",
    "authenticationMethodIds": [
      "did:web:bob.example#authentication-0"
    ],
    "keyAgreementMethodIds": [
      "did:web:bob.example#key-agreement-0"
    ],
    "service": "did:web:mediator.example"
  }
}
```

This event is durable resolution evidence for one authenticated or selected
peer key.

- `presentedDid` is the exact DID string supplied for resolution, preserved
  across any resolver-internal URL or DNS normalization.
- `did` is the canonical DID used by folds under [relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile),
  including its exact-string rule for `did:web`. For Peer DID numalgo 4 it is
  the short form; first disclosure keeps the long form in `presentedDid`.
- `documentCid` names the raw DASL object containing exact RFC 8785 canonical
  resolved DID document JSON. Its CID commits to those bytes.
- the authenticated `peerPublicKey` must be present under the named DID and exact
  document;
- `authenticationMethodIds` and `keyAgreementMethodIds` enumerate all methods authorized
  for those purposes in the exact retained document, with references resolved
  against that document's `id`. They do not prove every listed key controlled the
  observed message; the key-agreement methods are historical chain evidence
  only when this snapshot is pinned by a relationship or verified transition
  under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity); and
- `service` is the selected DIDComm service URI or null.

A root `relationship.bound` pins this event as its initial peer-document
snapshot, on either send or receive. A later `from_prior` is verified
against this exact event and object, not an unrelated current web document.
If the event or object is temporarily missing, processing is deferred until
verified recovery material is available; absence is not proof that the
transition is invalid. Phase 1 does not depend on deferred vault sync.

For a `did:peer:4` first disclosure, the implementation decodes and validates
`presentedDid`, derives `did` and the document locally, and stores both forms.
A short form received before corresponding long-form resolution evidence is
known cannot establish an authenticated relationship.

For numalgo 4, let `L` be the retained validated long form and `S` its derived
short form. `documentCid` MUST store the
[Peer DID Method's long-form resolution result](https://identity.foundation/peer-did-method-spec/#resolving-a-did)
with optional reference expansion disabled. Starting from the decoded input
document, set the root `id` to `L`; preserve its `alsoKnownAs` array (or start
an empty array when absent) and append `S`; fill every omitted verification
method `controller` with `L`, including methods embedded in verification
relationships. Keep relative identifiers/references unchanged. Preserve all
other input members and array order, including any `@context` and explicit
external controllers; add nothing else. Serialize the result as UTF-8 RFC 8785
JSON. This section owns the stored representation; a resolver's optional
expansion, context injection or short-form output is not a storage choice.

Later short-form lookup or receipt MUST reuse or reproduce those same document
bytes and CID from `L`, even though `presentedDid` may now be `S`. New resolution
events may record another presented spelling, selected key or local `localKeyName`;
they do not produce a second document for the same numalgo-4 DID. Import
validates this representation against `L`; it never repairs a pin by rewriting
the retained bytes or CID. Method-ID comparison follows [section 6.4](#relationship-peertransitioned).

Equivalent duplicate observations are harmless. Same presented/canonical DID
and document CID with incompatible contents is an integrity conflict.

<a id="mediation-communication-dids-and-routes"></a>

## 5. Mediation, communication DIDs and routes

Mediation arrangements, communication DIDs and their private keys belong to
the vault. Their meaning never depends on the event author or the process
executing the full runtime. DID-document publication is outside vault state.

All communication DIDs have the same send, receive, binding and rotation
semantics. The core stores no public/pairwise role. Disclosure records and
local address-allocation policy describe whether an address is public or was
created for private use in one relationship. Routes are reusable vault-scoped
transport configurations. Resolving an external DID, including `did:web`, does
not create a local DID entity or a publication obligation.

<a id="mediation-events"></a>

### 5.1 Mediation events

<a id="mediation-created"></a>

#### `mediation.created`

```json
{
  "type": "mediation.created",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "mediatorDid": "did:web:mediator.example",
    "me": {
      "keyName": "mediation/019b2a51-118f-7e46-b31b-c63cd090c92c/me",
      "did": "did:peer:4zQm..."
    }
  }
}
```

This intent creates the stable vault-controlled identity for one mediation
arrangement. `me.keyName` MUST use the arrangement ID and `me.did` MUST match the
seed-derived key.

Repeating the same arrangement ID with different values is an integrity
conflict. A new attempt against the same mediator uses a new ID.

<a id="mediation-granted"></a>

#### `mediation.granted`

```json
{
  "type": "mediation.granted",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "routingDid": "did:peer:2.Ez..."
  }
}
```

This is the durable observation that the mediator granted the arrangement
and returned `routingDid`.

More than one distinct routing DID for one arrangement ID is a conflict. The
runtime MUST NOT guess which grant is authoritative; it establishes a new
arrangement or obtains an explicit current answer from the mediator.

<a id="mediation-selected"></a>

#### `mediation.selected`

```json
{
  "type": "mediation.selected",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c"
  }
}
```

This is the user's or policy's preferred mediation for newly configured
mediated routes. The latest event by canonical order wins.

Selection does not stop old arrangements from receiving. Any mediation
still referenced by a live route remains required.

<a id="mediation-retired"></a>

#### `mediation.retired`

```json
{
  "type": "mediation.retired",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "because": "replaced"
  }
}
```

Retirement is terminal for the arrangement ID. A procedure SHOULD retire or
replace every live route that depends on it first. If a retired mediation is
still referenced by a live route, the fold reports a routing configuration
conflict rather than silently changing a DID.

<a id="did-identity-and-keys"></a>

### 5.2 DID identity and keys

<a id="did-created"></a>

#### `did.created`

A locally controlled communication DID is a Peer DID:

```json
{
  "type": "did.created",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "did": "did:peer:4zQm...rendezvous-short",
    "longFormDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "boundRouteId": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73"
  }
}
```

The entity ID determines exactly
one authentication key name, `did/<id>/authentication`, and one key-agreement
key name, `did/<id>/key-agreement`, under [section 3.2](#single-seed). Both keys are immutable
for that entity; their names are derived, not stored as payload fields.

For every locally controlled communication DID:

- `did` is the canonical `did:peer:4` short form;
- `longFormDid` is the validated self-resolving long form;
- `boundRouteId` is REQUIRED and equals the route encoded in the input document;
- seed-derived public keys and route MUST match that document; and
- changing keys or route creates another DID entity and an explicit scoped
  transition.

The entity has a spelling set, not a DID string as its identity: in this
version the set consists of `did` and its validated `longFormDid`. A future
alias-declaration profile may extend that set with externally managed
spellings without making DID-document publication vault state; this version
defines no alias-declaration event or implicit equivalence from an external
document's claims.

The long form is disclosed before the short form is relied upon by a peer.
The short form is canonical for vault references and mediator recipient
registration after the mapping is known.

The early privacy allocator may use a UUIDv5 entity ID; ordinary
creation uses UUIDv7. Same ID with different identity fields is an integrity
conflict.

<a id="delivery-routes"></a>

### 5.3 Delivery routes

A route is a reusable, vault-scoped transport configuration. It does not
belong to a replica or a single communication DID. One rendezvous DID and many
pairwise DIDs may bind the same route, which is how they reuse a mediator
or direct ingress without sharing an application identity.

<a id="route-configured"></a>

#### `route.configured`

```json
{
  "type": "route.configured",
  "roots": [],
  "data": {
    "routeId": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "kind": "mediated",
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "endpoint": null
  }
}
```

`kind` is `mediated` or `direct`.

- A mediated route has non-null `mediationId` and null `endpoint`.
- A direct route has null `mediationId` and an absolute HTTPS or WSS
  `endpoint`.

A direct endpoint routes to a full vault runtime or an ingress service. It
MUST NOT identify one replica as the DIDComm application recipient. Configuring
the route does not itself register a recipient.

Equal configurations under one route ID are semantic duplicates. Different
values under one ID are an integrity conflict. A transport endpoint or
mediation change creates a new route ID and successor DID entities, allowing
old and new DIDs and routes to overlap during cutover. Each affected
relationship uses its own [section-6.5](#relationship-localtransitioned) local transition; mediation selection
does not migrate existing DIDs or change their immutable routes.

<a id="route-retired"></a>

#### `route.retired`

```json
{
  "type": "route.retired",
  "roots": [],
  "data": {
    "routeId": "019b2a58-fef5-7d59-ae1c-46e4f0a13c73",
    "because": "replaced"
  }
}
```

Retirement is terminal for the reusable route ID. Every DID that binds it
becomes visibly unroutable; restoring communication requires a successor DID
bound to a live route, not a route selection on the old entity. Retirement
does not erase retained messages.

<a id="disclosure"></a>

### 5.4 Disclosure

<a id="did-disclosed"></a>

#### `did.disclosed`

```json
{
  "type": "did.disclosed",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "as": "oob",
    "uses": "many",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb",
    "goal": "Write to Alice"
  }
}
```

`as` is `oob`, `profile` or `direct`; `uses` is `one` or `many`. `oobId`
is REQUIRED when `as == "oob"` and null otherwise. `goal` is nullable.
`data.didId` references the local entity's `did.created.data.didId` under
[section 3.5](#identifier-and-reference-vocabulary). Its DID spellings remain on that entity.
A one-use OOB invitation may disclose any live communication DID; matching
root-address receipt consumes it under [section 5.8](#invitation-fold).

This is the permanent record that an address was revealed. Before disclosure,
a mediated `boundRouteId` MUST have currently verified recipient registration.
Reusable/public disclosure SHOULD use an address allocated for discovery, and
SHOULD NOT publish an address already allocated for private communication.
These are privacy policies, not relationship-formation or cryptographic role
checks. First disclosure exposes the validated `did:peer:4` long form.

<a id="did-retired"></a>

### 5.5 `did.retired`

```json
{
  "type": "did.retired",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "because": "contact-deleted"
  }
}
```

Retirement is terminal for new sending, disclosure and relationship births
using this DID. Its mediated recipient registration leaves the desired set.
It does not erase keys, documents, bindings, received messages or rotations.

An already bound historical local address remains eligible for authenticated
receipt while its bound route has no terminal dependency, including after DID
retirement. This rule applies equally to publicly disclosed and privately
allocated addresses. No renewed registration is required to drain retained
deliveries. An unknown address pair cannot establish a new relationship on a
retired local DID. [relationships.md section 9](relationships.md#uniform-receipt) owns the receipt gates;
[distributed-delivery.md section 4.3](distributed-delivery.md#receive-a-message) owns the receive procedure.

Retain the key/document evidence and usable mediation needed by existing
relationships. Their messages still scope through the historical local chain;
current contact tombstones and sender/route availability govern new work.
Retained confirmation may authorize a scoped recovery rotation under [section 6.5](#relationship-localtransitioned), without reviving a retired route. Work already committed is not erased
by retirement. A late message attributed to a deleted contact triggers [section 13.6](#delete-a-contact)'s idempotent cleanup, never renewed interaction.

<a id="142-mediation-fold"></a>

<a id="mediation-fold"></a>

### 5.6 Mediation fold

For each mediation ID:

- exactly one consistent `mediation.created` defines mediator and key;
- one consistent `mediation.granted` makes it usable;
- any `mediation.retired` makes it terminal; and
- conflicting create or grant values make it unusable and visible as a
  conflict.

The preferred mediation is the latest `mediation.selected`. If it is missing,
ungranted, retired or conflicted, preferred is null and policy must select
another before configuring a new mediated route.

The **required receiving set** contains every usable mediation that is preferred
or referenced by a configured, non-retired, conflict-free route bound by a live
local DID or a retired local DID retained in an existing relationship's local
history. DID/key identity evidence must be consistent. Allocation/disclosure
policy has no effect on this set. An unpreferred mediation leaves only when no
such dependency remains or it becomes unusable.

This is independent of the desired recipient registration set: draining
retained messages does not re-register a retired DID. Terminal routes and
mediations stop receipt; temporary unavailability does not erase dependencies.

The active runtime reconciles recipients and drains account-scoped pickup on
every reachable mediation in this set. A hosted runtime receives no special
ownership.

<a id="143-route-did-and-key-fold"></a>

<a id="route-did-and-key-fold"></a>

### 5.7 Route, DID and key fold

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

- exactly one consistent `did.created` defines its spelling set, fixed
  keys and immutable `boundRouteId`;
- disclosures are every valid `did.disclosed` in canonical order; and
- any `did.retired` makes the DID entity terminal.

The fold verifies all of the following:

- key names are derived from the DID entity ID and the fixed purpose suffixes
  in [section 3.2](#single-seed);
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
`(canonical DID short form, boundRouteId)` pair for a live DID whose bound route
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
registration; new receipt uses [section 5.5](#did-retired) and [relationships.md section 9.2](relationships.md#hard-pre-vault-gate)'s
eligibility rule for live and retained historical addresses.
Ambiguous or inconsistent mapping is an integrity conflict and prevents
cryptographic use.

<a id="149-invitation-fold"></a>

<a id="invitation-fold"></a>

### 5.8 Invitation fold

An OOB disclosure with `uses == "one"` is available while its DID is live and
no matching committed root-address receipt has consumed it. The rule applies
to any communication DID; allocation labels do not authorize consumption.

A root-address receipt has non-null `relationshipBindingEventId`, null `fromPrior`
and `peerTransitionEventId`, the binding's root local key as `localKeyName`, and the binding's
canonical root peer DID as sender. It consumes a local invitation when `pthid`
equals that disclosure's `oobId` and the actual local recipient is the disclosed
DID. Its consumer is the binding's symmetric `R`. A continuation, another
local recipient or a remote invitation never satisfies this rule merely by
sharing `pthid`. No contact, rotation or application response is required.

The operation lock covers invitation availability, binding selection and inbound
commit. A different consumer of an unavailable invitation is terminally rejected
before receipt. The same consumer may reuse it or consume another matching
invitation with a new root-address input. Duplicate receipt never takes it
twice. A crash before inbound commit consumes nothing; after commit the
consumption survives without contact or reply work.

Deletion, erasure, retirement and clock rollback never reopen a consumed
invitation. Import with different consumers leaves it unavailable and exposes
an integrity conflict; arrival order chooses none. A later intent/sender
conflict does not release a structurally valid committed consumption. No
consumption event is necessary. A reusable disclosure remains available for
new relationships while its DID is live; disclosure policy chooses which
addresses to publish under [relationships.md section 6](relationships.md#out-of-band-discovery).

<a id="12-relationships-and-address-changes"></a>

<a id="relationships-and-address-changes"></a>

## 6. Relationships and address changes

A relationship is an unordered pair of birth addresses with a stable ID and
two independently replaceable ends. Public, rendezvous and pairwise describe
address allocation/disclosure policy, not different relationship types. The
local perspective supplies `localDidId` and the peer end; it does not affect the ID.
[relationships.md section 5](relationships.md#symmetric-relationship-identity) owns the symmetric ID derivation.

<a id="121-receipt-and-relationship-evidence"></a>

<a id="receipt-and-relationship-evidence"></a>

### 6.1 Receipt and relationship evidence

After network resolution and authentication, the enclosing receive operation
acquires the vault-wide operation lock of [event-store.md section 10](event-store.md#vault-interface).
Hold it from pair lookup and [relationships.md section 9.3](relationships.md#integrity-checks-and-durable-receipt)'s checks through the dependent resolution, binding and receipt
commits; nested `Vault.commit` calls share it. Release it before network work
or waiting for missing evidence. Outbound birth preparation uses the same lock
for its binding lookup, recheck and commit. This serializes the operations
without making separate commits one crash-atomic batch.

Every authenticated delivery uses the same relationship lookup,
irrespective of the recipient's allocation policy. Under the operation lock:

1. look for the received local DID and canonical sender DID in the address
   histories of existing relationships under [section 6.6](#relationship-fold-and-address-index);
2. if a `from_prior` is carried, use `iss` only as an additional lookup hint;
   [section 6.4](#relationship-peertransitioned) must verify the proof before it authorizes any continuation;
3. for proof-free input, select the unique existing binding and, for a peer
   successor, the committed transition that pins that successor document;
4. only for a previously unknown address pair with no carried proof, no known
   pending membership, no missing relationship evidence as defined below and
   no conflicting membership, select a new binding under [section 6.2](#relationship-bound) using
   the actual recipient DID and authenticated sender resolution; and
5. apply [relationships.md section 9.3](relationships.md#integrity-checks-and-durable-receipt)'s receive-time superseded-sender and
   integrity checks; commit/reuse the selected binding before freezing its
   returned `eventId` in `message.in.relationshipBindingEventId`, and freeze
   `peerTransitionEventId` under [section 10.2](#message-in). Commit receipt before ACK processing,
   contact policy or reply effects.

The root addresses are canonical DIDs, not authentication keys. An unknown key
under a recognized DID is [section 7.6](#contact-fold)'s diagnostic, never a new relationship.
A new input with an unresolved carried proof may commit with a null binding;
its eventual scope must come from the validated transition carrying that exact
observation. Missing relationship evidence defers and conflicting matches
suppress effects; neither permits a new birth-address fallback. A proof-free
input lacking enough local history to choose its binding remains pending before
durable receipt, without pickup ACK, under [relationships.md section 9.1](relationships.md#deferred-delivery)'s
relationship-evidence retry rule.

**Missing relationship evidence** means a binding, rooted transition prefix,
historical snapshot or completed verification required to select the exact
pair's binding/transition is absent or incomplete in the local evidence set.
It requires a reference or claim that makes that evidence necessary; a
previously unknown proof-free pair with no such claim can still form a birth
under step 4.

**Known pending membership** means either incomplete evidence referenced by
an existing binding/edge claim for the exact canonical `(local recipient DID,
sender DID)` pair, or a committed authenticated `message.in` at that pair with
a syntactically valid `fromPrior` whose `sub` equals its authenticated
`presentedDid`, for which [section 6.4](#relationship-peertransitioned)'s valid `relationship.peerTransitioned`
has not yet committed. A missing `iss`-pair binding, rooted prefix or historical snapshot
all count, as does verification work left unfinished after receipt. A known
invalid proof is conflicting membership instead. The carrier's unverified
claims supply no scope and create no address-index edge, but its exact pair
MUST wait for verification
before a later proof-free delivery can commit; omitting the proof is not a new
birth. This is a receive-time deferral, not grounds to reassign or invalidate
earlier committed receipts.

Recompute this pending state from retained event headers on reopen and after
body erasure. Recovering the predecessor evidence and committing the verified
edge permits subsequent proof-free receipt in the original R. If the recovered
evidence is incompatible, apply the ordinary conflict rule instead. With no
recoverable predecessor, this pair remains pending; a sender's new wire ID,
timeout or restart does not clear it. The claim does not block the sender at
an unrelated local address or authorize continuation there.

Receipt and relationship formation do not require a contact, a reply, a private
address or a completed rotation. A control message may establish a binding and
process scoped ACKs without creating a contact or selecting a privacy reply.
Application/contact policy is defined in [relationships.md sections 5.2](relationships.md#binding-and-contact-policy) and [11](relationships.md#early-private-address-policy-and-notifications).
One-use invitation integrity follows [section 5.8](#invitation-fold) at the receipt boundary.

These immutable evidence references preserve a message's interpretation through
erasure, restart and partial import. Import validates references against the
event union, never event arrival order. A later conflicting address claim
cannot move earlier input or emitted effects into another relationship.

<a id="122-relationshipbound"></a>

<a id="relationship-bound"></a>

### 6.2 `relationship.bound`

The same event pins a relationship's birth addresses and initial peer document
on either a send or a receive path. It records no handoff, origin message,
contact, local successor or acknowledgment.

```json
{
  "type": "relationship.bound",
  "roots": [],
  "data": {
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "localDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "peerResolutionEventId": "019b4d11-22d3-7fd0-82fb-f33864a75dd4"
  }
}
```

`localDidId` names a local communication DID. The exact referenced `peer.resolved`
has `localKeyName == did/<localDidId>/key-agreement`; its canonical `did` supplies the
other birth address. Both addresses are distinct. `relationshipId` equals
section [5](relationships.md#symmetric-relationship-identity) of [relationships.md](relationships.md)'s derivation over their sorted canonical strings.
The local DID's document and the peer resolution snapshot retain their exact
presented spellings, key authorizations and routes. Every key-agreement key
authorized by that peer document starts `peerChain(R)`; the selected transport
key is not the relationship's identity.

For a new outbound, the writer first commits the offline intent's `birth`
selection under [section 9.2](#message-out). After resolution and before preparing/submitting
its first package, commit this binding. For new inbound, authentication and
`peer.resolved` commit first, then this binding in its own commit, then
`message.in` referencing the binding's returned `eventId`. Keep the operation lock
across these dependent commits under [section 6.1](#receipt-and-relationship-evidence). A crash after
the binding commit leaves reusable binding evidence and no receipt; it consumes
no invitation and creates no pickup ACK or ultimate ACK/effect work. A binding
is local address and key evidence, not a claim that the peer received a message
or approved contact.

Once bound, send and receive paths reuse it. A matching reverse-direction
first message does not create a second binding or contact. Equivalent
resolution references with the same canonical DID, exact document CID and
root local DID are equivalent binding evidence; different selected keys within
that same document do not conflict. Incompatible roots, local perspective or
peer document CIDs for one `R` are a binding conflict. A fresh resolver result
cannot replace the pin; section [10.1](relationships.md#did-resolution-requirements) of [relationships.md](relationships.md) governs new authentication
and preparation independently.

The birth addresses and initial pin never change after rotation. Another
relationship may use either address: ownership of a DID by a single `R` is not
a core invariant. The unique *pair* lookup and conflict rules are in [section 6.6](#relationship-fold-and-address-index). A local allocator SHOULD choose fresh addresses for privacy.

<a id="123-relationshipcontactassigned"></a>

<a id="relationship-contactassigned"></a>

### 6.3 `relationship.contactAssigned`

Contact assignment is a separate local decision and does not establish
cryptographic identity, choose a current address or change `R`.

```json
{
  "type": "relationship.contactAssigned",
  "roots": [],
  "data": {
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da"
  }
}
```

An outbound selected through a contact commits this assignment with its intent,
even if the birth binding still awaits resolution. On inbound, ordinary
application policy assigns an existing selected contact or the deterministic
contact ID in [relationships.md section 5.1](relationships.md#contact-ids); control input alone assigns none.
The writer reuses an existing assignment under its lock. Equal assignments
are duplicates; distinct contacts assigned to one `R` are a visible assignment
conflict, not an arrival-order choice. One contact may hold many relationships.
Missing contact/binding references defer dependent UI or sending work.

A contact tombstone blocks new interaction in every relationship assigned to
that exact contact. The assignment survives deletion and erasure; rediscovery
of the same address pair cannot escape that tombstone. Display merges neither
rewrite assignments nor merge relationships. An unassigned relationship can
receive and run permitted control/ACK work without inventing a contact.

<a id="112-relationshippeertransitioned"></a>

<a id="relationship-peertransitioned"></a>

### 6.4 `relationship.peerTransitioned`

```json
{
  "type": "relationship.peerTransitioned",
  "roots": [],
  "data": {
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerPublicKey": "<bob-pairwise-public-key>",
    "fromDid": "did:web:bob.example",
    "presentedFromDid": "did:web:bob.example",
    "toDid": "did:peer:4zQm...bob-pairwise-short",
    "presentedToDid": "did:peer:4zQm...bob-pairwise-short:z...bob-pairwise-input-document",
    "fromPrior": "eyJ...",
    "priorResolutionEventId": "019b4d11-22d3-7fd0-82fb-f33864a75dd4",
    "peerResolutionEventId": "019b4d14-18bd-77f1-b4a4-5c2a6c2694ba",
    "messageId": "3e7a2368-4a71-5560-8785-348ca4fbf548"
  }
}
```

This event is lifted only from a valid DIDComm `from_prior` in the named
inbound message.

- `relationshipId` is REQUIRED and names the exact relationship whose peer end
  is continued.
- `fromDid` is the canonical prior DID.
- `presentedFromDid` is byte-for-byte equal to `from_prior.iss`.
- `iat` is an integer Epoch-Seconds value retained in the JWT. It has no
  message-age acceptance window and does not choose a document snapshot;
- the protected JWT `kid` has a DID portion byte-for-byte equal to
  `presentedFromDid` and is authorized by the named historical resolution under
  the method-ID comparison below;
- `toDid` is the new canonical DID; for Peer DID numalgo 4 it is the short form;
- `fromDid` and `toDid` MUST differ; a same-DID document/key update, including
  long/short spellings of one DID, cannot use this rotation event;
- `presentedToDid` is byte-for-byte equal to `from_prior.sub`, plaintext `from`
  and the DID portion of authcrypt `skid`; for Peer DID numalgo 4 it is the
  valid long form on first disclosure. Other supported peer DIDs use their
  validated exact spelling under [relationships.md section 10.1](relationships.md#did-resolution-requirements);
- `priorResolutionEventId` names the exact `peer.resolved` event whose document and
  authentication method verify `fromPrior`;
- `peerResolutionEventId` names the successor's exact `peer.resolved`; and
- `messageId` names the inbound observation group carrying the proof.

Apply [section 10.5](#complete-observation-witnesses) to committed observations with that `messageId`. Each
complete witness must match this event's `peerResolutionEventId`, `localKeyName`
and exact `fromPrior`; its derived `peerPublicKey` equals this event's
`peerPublicKey`, and its `presentedDid` equals `presentedToDid`. The verification
below uses that same complete witness and the named predecessor/successor
snapshots.

The verifier MUST use the named historical resolution snapshot. A network
fetch of a newer `did:web` document is not a substitute unless the raw CID of
its canonical bytes exactly matches the pinned document CID. Missing snapshot
material creates a retryable deferred state; an invalid signature, claim, key
or long form is a conflict.

For predecessor spelling comparison, canonicalize `presentedFromDid`/`iss` under
[relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile) and require equality with `peer.resolved(priorResolutionEventId).did`.
Byte equality with `peer.resolved(priorResolutionEventId).presentedDid` is not required. Numalgo-4
long/short equivalence requires validation of the long form and its derived
short form; other supported methods use that section's canonicalization,
including the exact-string fallback, never inferred aliases from shared keys
or service endpoints.

To match the protected `kid` to an authentication method authorized by the
pinned document, resolve that document's relative method references against
its `id`, then apply the same canonicalization to only the DID portion of both
DID URLs. All remaining components, including the method fragment, MUST match
byte-for-byte. Verify the original JWT signing input using that pinned method's
key. This comparison does not rewrite the JWT, either resolution's retained
spellings, document bytes or CID, and never authorizes a key from a newer
document. A valid long-form `iss`/`kid` can therefore verify against a snapshot
whose `presentedDid` is the short form of the same numalgo-4 DID; its stored
document still uses [section 4.4](#peer-resolved)'s long-form representation.

`localKeyName` MUST be in
`relationshipRecipientKeyNames(R)` under [section 6.6](#relationship-fold-and-address-index). This includes every historical
local-chain key, starting with the birth address. The actual local recipient
and retained predecessor evidence must identify one unique `R`; neither address
alone supplies scope.
The named inbound MUST authenticate the successor, and its derived peer key
MUST equal this event's `peerPublicKey`. `fromDid` MUST equal the canonical DID
of `peer.resolved(priorResolutionEventId)`, which is one of that relationship's
pinned or verified predecessor snapshots
under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity), starting with the common root binding.
A transition cannot move a peer end into a different relationship merely
because the contact or prior DID is shared.

The bound root snapshot verifies the first remote transition; later ones use
the named historical snapshot in that same peer chain. Each complete witness's
`relationshipBindingEventId`, when non-null, must name this `R`; its exact local key
must belong to the rooted local history. Commit transition evidence before
processing the carrier's ACKs or effects. Missing evidence defers; ambiguous
or incompatible attribution conflicts. Threads, contact labels and current
resolver results cannot substitute for a predecessor proof.

The transition updates only this relationship's peer end. It does not globally
alias or retire the predecessor, nor transfer contact decisions between `R`s.
Existing contact attribution follows [section 6.3](#relationship-contactassigned); an unassigned relationship
can rotate without creating a contact. Its profile history stays with that
same R under [section 7.5](#relationship-profile-fold).

The first committed transition pins its successor document. On a repeated
carrier/proof, reuse that transition; a later resolution or duplicate inbound
cannot enlarge its key set. The same relationship, predecessor and compact
proof with a different successor document CID is a transition conflict, not a
second authorization. Equivalent resolution events for the same exact document
do not change the key set. Import checks this evidence without selecting a
winner by arrival order.

The peer chain is rooted at the binding's pinned canonical peer DID. A later
edge continues a reachable predecessor in that same chain; its successor must
not already occur in the predecessor prefix. Duplicate proof evidence reuses
its edge. Competing successors/proofs for one predecessor, cycles and
incompatible document evidence conflict; missing rooted prefixes defer.
`currentPeerDid(R)` is the unique final node, independently of liveness.
Canonical time never chooses a branch or rolls the current end back. The
compact JWT is evidence, not an object reference.

<a id="124-relationshiplocaltransitioned"></a>

<a id="relationship-localtransitioned"></a>

### 6.5 `relationship.localTransitioned`

This event replaces our current address inside one `R`. It is used for the
first public-to-pairwise change and every later change with identical semantics.
Remote changes use [section 6.4](#relationship-peertransitioned)'s authenticated evidence; both folds apply the
same scoped, directed predecessor-to-successor rule.

```json
{
  "type": "relationship.localTransitioned",
  "roots": [],
  "data": {
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "fromDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "toDidId": "019b6a10-12c0-7410-89ab-38e54b097c21",
    "fromPrior": "eyJ...",
    "triggerEventId": null
  }
}
```

`fromDidId` and `toDidId` are distinct local DID entity IDs, with no role test.
The successor MUST NOT already occur in this relationship's local chain. The
ordinary allocator uses a fresh UUIDv7; the early privacy policy MAY use the
deterministic successor ID in [relationships.md section 5](relationships.md#symmetric-relationship-identity). A DID used by another
relationship is not, by itself, a chain conflict. The privacy allocator MUST
avoid such reuse; imports still validate address-pair ambiguity, not exclusive
DID ownership.

`localChain(R)` starts at `relationship.bound.localDidId` and includes every
validated local transition, its document and fixed key. `currentLocalDidId(R)`
is the `DidId` of the unique final node regardless of liveness. Equal transitions are
idempotent. Competing successors/proofs for one predecessor, cycles or
incompatible binding/proof evidence are conflicts. Missing evidence defers.
Neither event timestamps nor a live predecessor can select a winner or roll
back the current end. Changes to the two different ends of `R` commute.

Before a local edge, require a committed conflict-free binding, a permitted
contact assignment if one exists, `fromDidId == currentLocalDidId(R)`, and retained
authenticated input in `R` addressed to that exact predecessor. A protocol
error that declines interaction is not confirmation. This condition already
holds for a normal first incoming message to the root address; it does not
require either side to have a pairwise address or to rotate first. Each later
edge waits for confirmation of its predecessor, so the peer can verify the
next proof. Import validates confirmation using the rooted prefix without this
edge or its descendants, not event timestamps. Receipt at another historical
local address does not confirm this predecessor or successor.

`fromPrior` is one byte-stable compact JWT under
[DIDComm DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation).
Its `iss` is the predecessor's exact long form, its protected `kid` uses that
spelling and an authorized authentication method, `sub` is the successor's
long form, and integer `iat` is sampled once at rotation. Validate the signature
against the immutable predecessor document. First disclosure of a local
address always supplies this pinned long form under [relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile). Subsequent short-form messages do not change the pin.

`triggerEventId` is REQUIRED and nullable. It names the `eventId` of the exact committed
`message.in` observation, not its shared `messageId`, selected when the automatic
early-privacy policy starts this transition; that input must supply the
predecessor confirmation and qualify under
[relationships.md section 11](relationships.md#early-private-address-policy-and-notifications). A manual/local rotation uses null. This reference
only recovers the notification effect; relationship identity and chain folding
do not depend on a handoff response. Repeated edge evidence must agree on it.

Commit the successor and edge atomically before disclosure. Retain the exact
keys, bound route, proof and trigger through restore and message erasure.
Until authenticated scoped input arrives at that exact successor, every new
package from it carries this proof and uses its long form. After confirmation,
new packages omit the proof and may use the short form. Before the first local
edge, a root sender carries no rotation proof. Explicit ACK information is
independent of exact-address confirmation and submission completion.

A rotation keeps a previously live predecessor, its route and mediation live
through successor confirmation. Both recipient registrations overlap. It does
not globally retire or alias a shared address; afterward resources may retire
only when no other relationship or disclosure still requires them. Explicit
retirement, contact deletion and emergency shutdown remain separate operations.
An independently retired predecessor may sign a recovery edge when its retained
confirmation and key evidence qualify; this does not revive terminal routes.

Every unsubmitted outbound already names `R`. From edge commit onward, retire
superseded packages and repack from the current local end, preserving message ID,
intent, execution ID and ACK targets, including a message carrying `birth`
metadata. Birth addresses identify `R`; they do not pin a current sender.
Submitted message IDs never reopen. An unavailable current end blocks work without
falling back to a predecessor or another relationship.

An unconfirmed successor with a terminal route and no retained confirming input
still has no continuation recovery in this profile: no branch or rollback is
authorized. A new relationship requires a new address pair. Temporary outages
are not terminal. Notification uses an ordinary message under [relationships.md section 11](relationships.md#early-private-address-policy-and-notifications); the edge itself creates no wire-level handshake or ACK obligation.

<a id="144-relationship-fold-and-address-index"></a>

<a id="relationship-fold-and-address-index"></a>

### 6.6 Relationship fold and address index

Group `relationship.bound` by symmetric `R` under [section 6.2](#relationship-bound). Root addresses
and the initial peer document remain immutable. Fold local and remote chains
independently under [sections 6.5](#relationship-localtransitioned) and [6.4](#relationship-peertransitioned). Derive `R` only from birth evidence,
never from the current endpoints, selected public keys, contact, sender role,
message ID or arrival order.

For each `R`, retain local and peer address histories and each node's exact
document evidence. `relationshipRecipientKeyNames(R)` is the set of `KeyName`
values for all historical keys in `localChain(R)`, including its root.
No additional rendezvous recipient
rule exists. The index of `(local canonical DID, peer canonical DID)` is the
full Cartesian product of the canonical DID nodes in `localChain(R)` and
`peerChain(R)`, including every root and intermediate historical node on each
side. It is an index for finding candidate relationships, not a substitute for
current sender authentication,
per-document key authorization, proof validation or lifecycle checks.

Sharing one DID across different relationships is permitted. If the same pair
is claimed by distinct `R`s, retain a relationship-scope conflict for every
claimant. This includes an independently bound birth pair later claimed by a
continuation from another `R`. Do not merge their IDs, move messages, replay
effects or elect a winner by event order. Validate claims before this conflict
test so discarding one conflicted claimant cannot make another win. Missing
referenced evidence defers dependent work. The writer rejects newly conflicting
claims under its lock; import preserves conflicts and suppresses new work.

Scope for an incoming message is derived from its immutable binding reference
and the exact root or successor document authorizing its peer key. A carried
proof additionally needs the verified `relationship.peerTransitioned` for that
observation; a proof-free successor uses its frozen `peerTransitionEventId`. Null binding on a
proof carrier remains pending until its transition supplies the binding. No
incomplete/conflicting proof or known address claim authorizes a new birth.
[Section 6.1](#receipt-and-relationship-evidence) defines the pending claim from an unmatched committed carrier;
that claim defers new receipt without adding an unverified edge to this index.
The same-DID unknown-key diagnostic follows [section 7.6](#contact-fold). Full per-observation
and message ID-group scope validation belongs to [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity).

`relationship.contactAssigned` supplies zero or one contact; multiple distinct
assignments are conflicts. Contact existence, assignment or deletion never
changes `R`. Tombstones, invitation conflicts, erasure and current sender
eligibility govern new effects, while committed receipt and prior effects
remain history. An unassigned control relationship needs no contact to process
permitted ACKs. Reopening a vault enumerates unfinished receipt, contact policy,
local transitions and notification effects from their retained evidence.

Each relationship has one current local and one current peer end. A valid
transition changes only its named end in its named `R`. A public root may
remain current indefinitely. Neither direct communication nor the absence of
rotation is an incomplete relationship. Exact-successor confirmation controls
proof disclosure, not whether the relationship exists or messages may be sent.

<a id="7-contacts"></a>

<a id="contacts"></a>

## 7. Contacts and profiles

A contact is a set of decisions identified by one `contactId`. It may hold an
unverified discovery DID before a relationship is bound, and may have several
relationships assigned under [section 6.3](#relationship-contactassigned). Each relationship preserves its
identity as either end changes address. Contact IDs name local decisions;
they do not merge protocol identities.

<a id="contact-ids"></a>

### 7.1 Contact IDs

See [relationships.md section 5.1](relationships.md#contact-ids).

<a id="contact-event-schemas"></a>

### 7.2 Contact event schemas

<a id="contact-created"></a>

#### `contact.created`

```json
{
  "type": "contact.created",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "because": "user"
  }
}
```

`because` is `user` or `automatic`.

<a id="contact-petname"></a>

#### `contact.petname`

```json
{
  "type": "contact.petname",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "name": "alice"
  }
}
```

Latest by canonical order wins for that `contactId`.

<a id="contact-flag"></a>

#### `contact.flag`

```json
{
  "type": "contact.flag",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "flag": "pinned",
    "value": true
  }
}
```

Latest per `(contactId, flag)` wins.

<a id="contact-usedid"></a>

#### `contact.useDid`

```json
{
  "type": "contact.useDid",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "didId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "because": "relationship"
  }
}
```

This outbound preference associates one of our communication DID entities
with the contact. `data.didId` is that entity's `did.created.data.didId` under
[section 3.5](#identifier-and-reference-vocabulary). `because` is `relationship`, `rendezvous`,
`manual` or another documented policy value.

This preference selects among relationship addresses already eligible under
[sections 9.2](#message-out) and [7.6](#contact-fold). It cannot change an endpoint, roll back a rotation or
move a message between relationships. A publicly disclosed local address may
send normally; fresh private allocation is the default policy in
[relationships.md section 11](relationships.md#early-private-address-policy-and-notifications). `relationship.contactAssigned` supplies the
relationship-to-contact decision independently of these address preferences.

<a id="contact-peerdidadded"></a>

#### `contact.peerDidAdded`

```json
{
  "type": "contact.peerDidAdded",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "did": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "because": "oob"
  }
}
```

This records a peer DID selected as an outbound target before or independently
of a bound relationship. `because` is `oob`, `user`, `rendezvous`,
`resolved` or another documented source.

The event is a routing/contact decision, not proof that the peer controls the
DID. `peer.resolved` or a valid `relationship.peerTransitioned` supplies
cryptographic evidence later.

<a id="contact-peerdidremoved"></a>

#### `contact.peerDidRemoved`

```json
{
  "type": "contact.peerDidRemoved",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "addEventId": "019b2a64-86fa-7f28-a63a-5d70ce1d829a"
  }
}
```

`addEventId` is the `eventId` of one `contact.peerDidAdded`. Explicit references make
removal independent of wall-clock ordering. A scoped transition may make an
older rendezvous DID non-preferred without deleting the historical add event.

<a id="contact-merged"></a>

#### `contact.merged`

```json
{
  "type": "contact.merged",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "fromContactId": "019b2a66-c794-7b41-bff1-68a4ecdd0b67"
  }
}
```

`contactId` and `fromContactId` name the two contacts. This is a display-only
grouping hint between them. A UI MAY group
those contact views, but every member retains its own decisions and
relationship identity. This event MUST NOT affect attribution, DID selection,
transitions, message or execution identity, ACK scope, relationship receipt, invitation
consumption, deletion or erasure. It creates no protocol representative ID.

<a id="contact-deleted"></a>

#### `contact.deleted`

```json
{
  "type": "contact.deleted",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da"
  }
}
```

This is a permanent tombstone for exactly the named contact ID.

<a id="113-profilenameclaimed"></a>

<a id="profile-nameclaimed"></a>

### 7.3 `profile.nameClaimed`

```json
{
  "type": "profile.nameClaimed",
  "roots": [],
  "data": {
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "sourceEventId": "019b2a84-44ef-7d16-8d04-2b9a5c2a06b1",
    "name": "Alice L."
  }
}
```

`sourceEventId` is the `eventId` of one exact committed `message.in` observation, not its
`messageId` or wire ID. Its validated logical-message scope under [section 10.6](#inbound-message-and-execution-fold) MUST
equal `relationshipId`. The source and any required binding/transition evidence
MUST already be committed before this event is lifted. A pending, anonymous,
mediator or conflicted source supplies no profile claim.

A **supported profile disclosure** is a message whose application protocol
explicitly defines profile fields and their extraction. That protocol owns its
wire types, schema, validation and interpretation; this vault format selects no
profile wire protocol or implicit Basic Message convention. A producer lifts
only disclosures from protocols it supports, not names inferred from arbitrary
message content. This definition also applies to [section 7.4](#profile-shared).

The producer lifts `name` from a supported profile disclosure while its source
content is readable and eligible for application processing under [section 10.6](#inbound-message-and-execution-fold), checking erasure and contact tombstones under the operation lock. A claim
may belong to an unassigned R; later contact assignment only changes where it
is displayed. This lifted value survives source-body erasure; it is a peer's
claim, not a verified identity name. It holds no source content roots. Missing
event/scope evidence defers projection and incompatible evidence conflicts;
source-body erasure alone does not invalidate an existing lifted value.
Deduplication and display ordering follow [section 7.5](#relationship-profile-fold).

Lifting under [sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared) is idempotent by event type and logical source.
Under the operation lock, reuse an existing valid lift; otherwise recognize and
lift the disclosure from eligible readable source content. Reopen/recovery
enumerates missing lifts under [section 13.1](#open-the-writable-full-runtime), including sources whose scope
became available later. Missing content defers this work; erased content or a
contact tombstone forbids a new lift. Erasure before lifting may therefore
leave no profile fact; these events create no additional content hold.

<a id="114-profileshared"></a>

<a id="profile-shared"></a>

### 7.4 `profile.shared`

```json
{
  "type": "profile.shared",
  "roots": [],
  "data": {
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "sourceEventId": "019b2a85-0912-7b2c-9425-4fd7fd0dd019"
  }
}
```

`sourceEventId` is the `eventId` of one exact committed `message.out` profile disclosure.
Its immutable `relationshipId` MUST equal this event's `relationshipId`, and its
validated outbound membership follows [section 9.8](#outbound-message-and-delivery-fold). Lift this observation only
after that message ID has a committed valid `delivery.submitted`, recognizing the
supported disclosure from readable source content under [section 7.3](#profile-nameclaimed)'s writer
lock, erasure and tombstone rules. A queued intent, prepared package, unknown
transport outcome or peer ACK alone is insufficient.
Submission is the sharing boundary; this event does not claim that the peer
read the profile and cannot authorize another submission.

For an existing lift, the source intent, package/submission evidence and
relationship references remain verifiable from their retained skeletons after
content erasure. This verifies the retained lift's linkage; it does not
reconstruct a disclosure from `msgType` alone or permit a new lift without
readable content. Missing evidence defers projection; incompatible evidence
conflicts. No content roots are retained by this event. Deduplication and
display ordering follow [section 7.5](#relationship-profile-fold); rotation preserves this R's sharing
history. Recovering a missing lift never prepares or resubmits its source.

<a id="145-relationship-profile-fold"></a>

<a id="relationship-profile-fold"></a>

### 7.5 Relationship profile fold

Group valid `profile.nameClaimed` and `profile.shared` observations by their
`relationshipId`, verifying their source references under [sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared).
They do not establish a binding or assign a contact. Missing source/scope
evidence defers the affected records; conflicted evidence supplies no profile
value and remains visible as a diagnostic. An unassigned R retains its profile
history without contributing to a contact view.

Deduplicate each event type by its source logical message under [sections 10.6](#inbound-message-and-execution-fold)
and [9.8](#outbound-message-and-delivery-fold), including repeated lifts referencing different duplicate observations
or a verified cross-key alias. Equal lifted values count once. Different names
lifted from the same logical inbound are a profile conflict; preserve them
without choosing a name from that source by event order.

Order each logical source by its minimum complete canonical source-event key
under [event-store.md section 4.3](event-store.md#canonical-order), across its consistent source observations
or duplicate outbound intents. The latest non-conflicted name claim in R is
the claim with the greatest such key. The same rule orders shared-profile
sources. Lift-event timestamps do not make an old message newer; recovery or
duplicate receipt cannot advance its display position merely by lifting it
again. Existing lifted records remain usable after source-body erasure under
[sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared).

For each R, this fold yields:

- `claimedName`: the latest non-conflicted eligible name under the source
  ordering above, or null when none exists;
- `nameConflict`: true when otherwise valid lifts disagree on the name from at
  least one logical inbound source, false otherwise. Those sources supply no
  name, but other non-conflicted sources remain eligible; and
- `shared`: the complete canonical source key `(at, eventId, author)` of the
  latest valid logical `profile.shared` source under the same ordering, or
  null when none exists. This is that source's minimum key, not the lift's key
  or submission time.

Missing or conflicted relationship/source evidence contributes no value and
retains the diagnostics above. `nameConflict` reports disagreement between
lifted names; it does not replace these evidence diagnostics.

Rotation of either end preserves R and its profile history. Sharing a DID,
public key or contact with another R never transfers a name claim or marks our
profile as shared there. [Section 7.6](#contact-fold) aggregates names and sharing records only
through explicit relationship-to-contact assignments. These are projections,
not a policy requiring an automatic profile send. Profile evidence never
authorizes ACKs, effects, key membership or relationship continuation.

<a id="146-contact-fold"></a>

<a id="contact-fold"></a>

### 7.6 Contact fold

A uniquely scoped message takes its contact from `relationship.contactAssigned`.
The same assignment governs profile display. Shared DIDs, keys, discovery
seeds and contact display merges cannot assign an unassigned R, transfer its
profile history or change message scope and deletion boundaries.

Fold each `contactId` independently:

- deleted when that ID has a `contact.deleted` tombstone;
- `petname` is latest by canonical order;
- each flag is latest by canonical order;
- `claimedName` is the latest eligible name claim across relationships uniquely
  assigned to this contact, using [section 7.5](#relationship-profile-fold)'s source ordering; absent claims
  yield null, and missing/conflicted records supply diagnostics, not names;
- `profileShared[]` has one `{ relationshipId: R, sourceKey: shared }` for every
  non-conflicted R uniquely assigned to this contact whose [section-7.5](#relationship-profile-fold)
  `shared` is non-null, ordered by the literal R string. An unassigned,
  assignment-conflicted or relationship-conflicted R contributes none;
- `relationships[]` is every R uniquely assigned to this contact under [section 6.3](#relationship-contactassigned), retaining pending/conflict status where binding evidence is incomplete
  or conflicting;
- `localDidIds[]` contains the `DidId` values of the non-retired local address
  history of relationships assigned to this contact, with current ends
  identified separately;
- `peerDidSeeds[]` is every `contact.peerDidAdded` not named by a
  `contact.peerDidRemoved`;
- `peerDids[]` includes the canonical DID strings of the current peer ends of
  assigned relationships;
  unbound discovery seeds remain separate pending targets;
- `writeTo[]` is every non-conflicted assigned relationship meeting the
  portable sender, peer and route eligibility rules below; and
- `thread` is the logical application-message union under [section 10.6](#inbound-message-and-execution-fold).

`writeTo[]` contains the conflict-free relationships assigned to this contact
under [section 6.3](#relationship-contactassigned). A relationship may use any current address, including a
public root, without a qualifying first reply or handoff. Its current local
DID must be live and pass [section 5.7](#route-did-and-key-fold)'s portable identity/route checks; its
current peer end must have the pinned or verified evidence required for
preparation. An unbound birth intent remains queued under [section 9.2](#message-out) until
resolution supplies its binding.

`contact.useDid` can choose among eligible relationships, not change an end
or choose a predecessor. Network resolution, online transport and observed
registration are subsequent work, not prerequisites to offline intent commit.
Contact deletion and assignment conflicts suppress new interaction. A fold
cannot choose among competing address transitions by clock order. Privacy
policy may schedule an early rotation under [relationships.md section 11](relationships.md#early-private-address-policy-and-notifications), but
neither relationship formation nor ordinary sending waits for that policy.

For a same-DID key change under [relationships.md section 10.1](relationships.md#did-resolution-requirements), derive a
`peer-key-changed` diagnostic from the retained authenticated `message.in`,
its exact `peer.resolved` evidence and the unique relationship identified by
the local recipient DID and canonical peer DID. Show it in that relationship's
contact view through that R's unique contact assignment; the
diagnostic does not grant execution scope. Keep the affected
unscoped observation out of the application thread, unread count and normal
message notifications, and process no ACK or effect from its message ID group under
[distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity). If relationship evidence is missing or
ambiguous, retain the ordinary missing-evidence or conflict diagnostic rather
than assigning this one to an arbitrary contact. This no-proof observation
remains unscoped after restart and body erasure. A later valid rotation to a
different DID authorizes traffic under that successor DID, not this old
same-DID observation; a fresh local address can instead start a new
relationship. No new diagnostic event or retained body is needed.

The contact view derives remote-error diagnostics from a conflict-free logical
report with unique R scope. Match it to retained outbound packages in that
same R, using the protocol's thread and authenticated peer-document evidence.
Report Problem requires `report.pthid == (outbound.thid ?? outbound.messageId)` under
[relationships.md section 13](relationships.md#remote-errors-and-integrity-failures). Other protocols use their own correlation rules.
Exactly one compatible outbound must match; dropping conflicted evidence cannot
resolve ambiguity. The ACK array is never a rejected-message selector.

While the report body is readable, show its validated code/reason beside that
outbound's delivery outcome, once per logical report. Order different reports
by their earliest canonical observations. Body erasure removes its diagnostic,
even if another reference retains the bytes; unavailable content supplies no
inferred reason. An ambiguous or unmatched report supplies no attempt-specific
diagnostic. Silent rejection supplies none. A report does not terminate R,
confirm rotation, change submission completion or restart an outbound.

<a id="stored-message-document"></a>

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

Canonical projections and message hashes are defined by [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes).

<a id="9-outbound-message-events"></a>

<a id="outbound-message-events"></a>

## 9. Outbound messages and delivery

<a id="ids"></a>

### 9.1 IDs

- `messageId` is both the outbound vault message entity ID and the innermost
  DIDComm plaintext `id`.
- `packageId` identifies one exact encrypted inner envelope and is Routing
  2.0 `forward.id`.
- mediator `deliveryId` is not stored by outbound events.

A user send mints one UUIDv7 `messageId`. Every package uses it as plaintext `id`.
Outbound events do not store a second `wireMessageId`. Inbound observations keep
their scoped message ID and the received wire ID under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity); the equality applies only to locally authored outbound messages.

An automatic effect derives:

```text
messageId = UUIDv5(
  8847bd57-5907-5bcd-9a71-d1e97cee3199,
  RFC8785(["v1", effectKey])
)
```

The resulting `messageId` is also the response's wire ID. Retrying or repackaging
preserves this one ID. Equivalent automatic effects therefore identify one
logical response.

<a id="message-out"></a>

### 9.2 `message.out`

```json
{
  "type": "message.out",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "relationshipId": "35807a1e-3b8a-52f5-9580-29cd5265882e",
    "birth": null,
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "thid": null,
    "pthid": null,
    "createdTime": null,
    "expiresTime": null,
    "pleaseAck": [""],
    "ack": [],
    "headers": {},
    "bodyCid": "bafkrei...body",
    "attachmentCids": ["bafkrei...attachment"],
    "intentHash": "<base64url-sha256>",
    "executionId": null,
    "handlerId": null,
    "effectKind": null,
    "ordinal": null,
    "effectKey": null
  }
}
```

`relationshipId` is REQUIRED and non-null, stored directly in the payload.
A contact-send API selects one relationship before intent commit; an explicit
address API must resolve the same address-pair identity before using this
event. `relationshipId` is immutable and cannot be changed by later preferences,
contact merges or repacking. Anonymous or mediator control traffic does not
acquire application relationship scope through a selected key pair.

`birth` is REQUIRED and nullable. For a new address pair whose binding is not
yet committed, it contains the offline selection:

```json
{
  "localDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
  "peerDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document"
}
```

The local DID must exist and be live. Canonicalize the exact selected peer
spelling and derive `relationshipId` from the two birth addresses under
[relationships.md section 5](relationships.md#symmetric-relationship-identity). No online resolution is required to commit intent.
Repeated unbound sends freeze the same selection. A known binding uses null;
any non-null birth must agree with it. Missing evidence defers preparation,
and contradictory birth/binding evidence is a relationship conflict.

`birth` is creation evidence, not an initial-message protocol or a pinned
current sender. It remains unchanged if the same `R` later rotates either end.
Both `relationshipId` and `birth` are portable metadata excluded from wire
plaintext and message hashes, while still participating in full intent-event
equality.
Before first package preparation, [section 6.2](#relationship-bound) pins the peer document. Root
addresses can send ordinary content without first receiving a reply or
performing a rotation. Public/private allocation never gates send eligibility.

For an automatic response, `relationshipId` is exactly its carrier's derived `R`.
Preparation uses that `R`'s current local and peer ends; another relationship
of the same contact cannot substitute. Apply [distributed-delivery.md section 8.1](distributed-delivery.md#freezing-an-ack-target-set)'s local-sender gate under the operation lock. Contact assignment and
tombstones are checked when present; unassigned control relationships need no
invented contact.

Requirements:

- `createdTime` and `expiresTime` are Epoch-Seconds integers or null;
- when both are non-null, `expiresTime` is strictly greater than
  `createdTime`;
- null `createdTime` omits the DIDComm `created_time` header;
- `pleaseAck` is null or the exact ordered wire array; `ack` is the exact
  oldest-to-newest target array frozen by the response algorithm;
- `headers` contains every otherwise-unmodeled supported top-level DIDComm
  header and no reserved field, including `return_route`;
- `bodyCid` names the canonical stored message document;
- `attachmentCids` is the distinct ordered list of object-backed attachment
  payload roots from that document; link-only descriptors add no entry;
- `roots` is the distinct ordered set of `bodyCid` followed by `attachmentCids`;
- `intentHash` is computed under [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes);
- `executionId`, `handlerId`, `effectKind`, `ordinal` and `effectKey` are all
  null for a locally initiated send and all non-null for an inbound-triggered
  automatic effect. A local user or policy decision may initiate an ordinary
  message without a carrier; it commits intent before network effects;
- a locally initiated send has `ack == []`; honoring an inbound ACK request uses
  the deterministic response algorithm;
- `handlerId` and `effectKind` obey [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects);
  `ordinal` stores its `decimalOrdinal` as a canonical non-negative decimal
  integer string (`"0"` for zero, otherwise digits without a leading zero);
- an automatic intent stores the complete producing tuple. Validation checks
  its execution ID against the carrier group, its tuple and intent against the
  producing protocol, recomputes its key under [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects), and requires its `messageId` to equal the [section-9.1](#ids) derivation;
- the five automatic-effect fields are portable effect metadata excluded from
  the wire and intent hash; they still participate in full event equality;
- `thid`, `pthid`, `expiresTime` and all five automatic-effect
  fields are present with null when unused; and
- appending this event requires no network, resolver, mediator or socket.

A preparer emits `created_time`, `expires_time`, `thid` and `pthid` only when
non-null; emits `please_ack` whenever `pleaseAck` is non-null; emits `ack` and
`attachments` when non-empty; and expands `headers` at plaintext top level.

More than one `message.out` under one `messageId` is allowed only when every field
is identical. Different `relationshipId` or `birth` values conflict even when
the intent hashes agree. Reuse of one wire ID with a different intent projection
is an intent conflict.

<a id="message-prepared"></a>

### 9.3 `message.prepared`

```json
{
  "type": "message.prepared",
  "roots": [
    "bafkrei...encrypted-envelope"
  ],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "senderDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "recipientDid": "did:web:bob.example",
    "peerResolutionEventId": "019b2a72-0626-7a87-a310-941fe4c1ce77",
    "fromPrior": null,
    "intentHash": "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA",
    "plaintextHash": "WkPpglZREjLGtviZ1L6c-R3EX1cTHtbe0sJrmhl77LQ",
    "envelopeCid": "bafkrei...encrypted-envelope"
  }
}
```

This event makes one exact normalized encrypted envelope recoverable by every
replica.

Requirements:

- `senderDidId` names a live local DID entity selected for the relationship under
  [section 9.2](#message-out)'s restrictions; for ordinary relationship traffic it is
  `currentLocalDidId(R)` under [section 6.5](#relationship-localtransitioned) at preparation;
- the package belongs to `message.out.relationshipId`; root or valid
  rotated endpoint evidence must agree with that same `R`;
- `localKeyName` is that entity's key-agreement key and authorizes the plaintext
  `from` under the exact spelling used by the package;
- the plaintext `id` equals `message.out.messageId`; its other semantic fields
  and immutable control headers equal the committed intent;
- `intentHash` equals the intent value;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- `peerResolutionEventId` names the exact `peer.resolved` evidence used to select
  the recipient key; its `peerPublicKey` supplies the package's derived peer key.
  Its `localKeyName` equals the package's local key and its canonical `did` matches
  `recipientDid`. It is non-null for every phase-1 package, including a
  retained numalgo-4 resolution. First-package freshness and
  snapshot reuse follow [relationships.md section 10.1](relationships.md#did-resolution-requirements);
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization. The `envelopeCid` CID commits to those exact bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

All packages for one `messageId` MUST preserve its intent hash. No new package may
be prepared after that message ID is submitted under [section 9.8](#outbound-message-and-delivery-fold). Before then, a
new package MAY change `senderDidId`, `localKeyName`, `recipientDid`, the derived peer
key, `peerResolutionEventId` or `fromPrior` only when the change follows a valid selected
DID entity or verified relationship-scoped continuation for the same logical target.
Every such change requires a new package ID and plaintext hash. A protocol may
be stricter. Birth metadata never forces a package back to a superseded end.

Local rotation's current-sender, proof and repack rules are in [section 6.5](#relationship-localtransitioned).
Liveness and current-end selection are producer checks at preparation and
submission, not retroactive invalidation of historical package evidence.
On a local-key repack, a new `peer.resolved` MAY re-express the pinned recipient
snapshot with the new `localKeyName`, retaining the identical document CID, DID
spellings, selected peer key, authorized methods and service. This is local
evidence rebinding, not a fresh resolution or a peer-chain extension.

The package names no recipient replica. Rendezvous and pairwise
relationship messages follow the same package rules.

<a id="message-packageretired"></a>

### 9.4 `message.packageRetired`

```json
{
  "type": "message.packageRetired",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "because": "repacked",
    "replacementPackageId": "019b2a75-11bd-7ae2-8e41-279d84c2528a"
  }
}
```

`replacementPackageId` is nullable. Retirement permanently stops automatic
submission of this package; it does not terminate the logical message or
another package. Its envelope contribution is determined only by [section 12.3](#held-roots)'s retention predicate. Retirement preserves the package's historical
submission and scope evidence; it cannot undo a completed submission.

<a id="delivery-submitted"></a>

### 9.5 `delivery.submitted`

```json
{
  "type": "delivery.submitted",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c"
  }
}
```

This says only that one transport endpoint accepted the attempt. It does not
mean route existence, mediator retention, pickup or ultimate durable receipt.

`packageId` MUST identify a valid `message.prepared` for this exact `messageId`.
A local runtime appends this event after observing transport acceptance. Its
successful commit completes submission for the entire logical outbound under
[section 9.8](#outbound-message-and-delivery-fold). If acceptance happened but this event did not commit, recovery
may resubmit the existing package. No pre-call attempt event is required.

Transport, endpoint and response status are local trace data. They are not
fields of this portable event and do not participate in the delivery fold.

<a id="delivery-failed"></a>

### 9.6 `delivery.failed`

```json
{
  "type": "delivery.failed",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
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
  [relationships.md section 10.1](relationships.md#did-resolution-requirements) defines this failure before package preparation.

Retryable failures, the `resolve`/`prepare`/`submit` phase and retry diagnostics
belong only to local trace and retry policy. They MUST NOT append
`delivery.failed`. Losing that local state does not terminate the intent or
change its portable delivery state.

A worker that observes `now >= expiresTime` for an unsubmitted outbound before
prepare or retry appends that expired failure and submits nothing. It does not
append an expired failure merely because an already-submitted message later
reaches expiry. A later user attempt requires a new `message.out` and wire ID.
Sensitive strings remain in local trace; `code` is a stable non-secret value.

<a id="delivery-acknowledged"></a>

### 9.7 `delivery.acknowledged`

```json
{
  "type": "delivery.acknowledged",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerPublicKey": "<alice-pairwise-public-key>",
    "ackMessageId": "27c4471f-8937-501b-9ffb-a7eaeeebc178",
    "ackWireMessageId": "21559fb4-1a9f-54b1-b8fa-1bf82700d365"
  }
}
```

This event requires a complete observation witness under [section 10.5](#complete-observation-witnesses).
`ackMessageId` names the inbound observation group: candidates are committed
`message.in` events with that `messageId`. Each witness's `wireMessageId`,
`localKeyName` and derived `peerPublicKey` match this event's `ackWireMessageId`,
`localKeyName` and `peerPublicKey`, respectively, and its explicit DIDComm `ack`
array contains this event's outbound `messageId`. The witness must authenticate
the ultimate peer and pass [section 9.8](#outbound-message-and-delivery-fold)'s same-relationship, historical key-chain
and package/proof checks, plus any protocol-specific security preconditions.
Threading or a natural response without `ack` is insufficient.

The keys identify the ACK carrier and may differ from the old outbound
package's keys; [section 9.8](#outbound-message-and-delivery-fold)'s historical local/peer-chain membership permits
rotation between that package and its ACK.

An acknowledgment supplies receipt information independently of the outbound's
submission state. Duplicate observations are harmless. The earliest valid
carrier observation `at` under [section 9.8](#outbound-message-and-delivery-fold), compared with `expiresTime`,
determines the `late` receipt indicator. ACKs neither create a missing `delivery.submitted` nor
change preparation, submission or envelope retention. Acknowledged means
durable receipt by the peer vault,
not read or business acceptance.

An ACK-bearing problem report may acknowledge delivery while still being
excluded from a higher-level protocol success condition. In particular,
rotation confirmation requires receipt at the exact successor under [section 6.5](#relationship-localtransitioned), independently of the outbound named by an explicit ACK.

<a id="148-outbound-message-and-delivery-fold"></a>

<a id="outbound-message-and-delivery-fold"></a>

### 9.8 Outbound message and delivery fold

Group `message.out` by `messageId`. Multiple identical intent events are one logical
outbound. Different fields under one `messageId` are a conflict, including
`relationshipId`, `birth` and other local control fields excluded from the
intent hash.

An automatic message ID derives only from `effectKey`, so this same fold detects
different intents under one key. A conflicted message ID retains all variants and
their package history, but MUST NOT prepare or submit any variant;
arrival order does not select a winner. Previously emitted effects remain
history.

Also group automatic outbounds with non-empty `ack` by `executionId`. Each
execution permits at most one such logical outbound message ID, across all handler
IDs, effect kinds and ordinals. Exact duplicate intents count once. This
selection remains consumed after erasure, expiry or submission because the
intent skeleton remains history. Other protocol-defined effects with empty
`ack` do not consume the selection.

A local writer MUST reuse the selected ACK-bearing intent and reject an
attempt to add another message ID to that execution's selection, including within one
batch. If import supplies distinct ACK-bearing message IDs for the same execution,
retain all as an automatic-response conflict and suppress preparation and
submission of every competing response; arrival order selects no winner.
Previously emitted responses remain history.

ACK lookup uses `(carrier.logicalPeerScope, wireMessageId)`. Before applying an ACK,
derive the candidate outbound's membership from non-conflicted portable
evidence as follows.

An application outbound belongs to its immutable `message.out.relationshipId`.
Its birth metadata, if present, must derive that `R`; its retained binding and
every valid package must independently agree. A package uses a historical local
address in `localChain(R)` and a peer DID/key authorized by one exact document
in `peerChain(R)`. The binding and any required transitions must be complete
and conflict-free. An arbitrary `R` string or equal wire ID does not authorize
an ACK. Contact or address preferences cannot move the outbound after commit.

These joins work before or after rotation and include the first package in
either direction. Missing package/binding/proof evidence defers ACK application;
incompatible or ambiguous scope suppresses it. Historical packages retain
membership after retirement and erasure. Repacking preserves `R` and every
previously emitted effect's identity. Raw key equality supplies no fallback scope.
An ACK proves receipt, not remote contact approval or successful rotation.

Apply [section 10.5](#complete-observation-witnesses) to all committed `message.in` observations whose explicit
`ack` names this outbound's `messageId`. Let `ackWitnesses` be the set of
candidates that belong to a message ID group with no unresolved observation
and no conflict, authenticate the ultimate peer, have a unique derived scope equal to the
outbound's R, and pass the membership and proof checks above and any
protocol-specific ACK security preconditions. This set includes all valid
duplicates and distinct ACK carriers; it is not restricted to the group or
witness selected for one `delivery.acknowledged` event.

For a valid outbound:

- `packages[]` is every consistent `message.prepared` by `packageId`;
- all packages use the outbound `messageId` as plaintext `id` and agree on `intentHash`;
- packages may differ in plaintext hash, sender/recipient DID, keys and
  `fromPrior` only under validated repack rules;
- one package is inactive after `message.packageRetired` or a package-scoped
  terminal failure, while its skeleton remains historical evidence;
- `acknowledged` is true exactly when `ackWitnesses` is non-empty;
- `submitted` is true if any valid package has a committed
  `delivery.submitted` naming this exact `messageId` and `packageId`. Validation uses
  the retained intent/package skeletons; collecting or erasing an envelope,
  retiring a package or later changing a route cannot remove completion;
- once `submitted` is true, no new automatic preparation, repackaging or
  submission is permitted for any package of that message ID, including on duplicate
  input, restore or missing ACK;
- a message-scoped terminal failure, including expiry, permanently ends
  new automatic preparation/submission for that intent;
- before submission, work additionally requires no message terminal failure,
  unexpired timing, and valid available target/proof/content evidence.
  Submitting a chosen package also requires that it is not retired or
  terminally failed and its exact valid envelope remains available;
- after a committed `relationship.localTransitioned` for the outbound's `R`,
  preparation uses `currentLocalDidId(R)` under [section 6.5](#relationship-localtransitioned), and a package whose
  `senderDidId` is not that current end is not submittable. These predicates
  apply before package-retirement observations commit; [section 6.5](#relationship-localtransitioned) defines
  the package retirement and repack that recovery completes. Missing or
  conflicting local-chain evidence cannot authorize a fallback to an earlier end;
- `pleaseAck` and `acknowledged` do not affect these work predicates. An ACK
  received while `delivery.submitted` is absent does not synthesize completion;
  eligible submission may still resume.

For receipt timing, `receiptInstant` is the earliest parsed RFC 3339 `at` among
all observations in `ackWitnesses`. `late` is true exactly when `acknowledged`
is true, `expiresTime` is non-null, and
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

<a id="10-inbound-message-events"></a>

<a id="inbound-message-events"></a>

## 10. Inbound messages and execution

<a id="deterministic-inbound-observation-message-id"></a>

### 10.1 Deterministic inbound observation message ID

See [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity).

<a id="message-in"></a>

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "roots": [
    "bafkrei...body",
    "bafkrei...attachment"
  ],
  "data": {
    "messageId": "369d7a43-8dce-5b86-b073-e390d457f357",
    "wireMessageId": "019b2a70-f225-721c-835f-67175be0667e",
    "receiptOrdinal": "42",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "peerResolutionEventId": "019b2a71-4c18-760a-9017-b3e265aa89d0",
    "relationshipBindingEventId": "019b4d11-22d3-7fd0-82fb-f33864a75dd5",
    "peerTransitionEventId": null,
    "presentedDid": "did:web:bob.example",
    "did": "did:web:bob.example",
    "thid": null,
    "pthid": null,
    "createdTime": 1788442800,
    "expiresTime": null,
    "pleaseAck": [
      ""
    ],
    "ack": [],
    "headers": {},
    "fromPrior": null,
    "bodyCid": "bafkrei...body",
    "attachmentCids": [
      "bafkrei...attachment"
    ],
    "bytes": 48213,
    "signedBy": null,
    "receivedVia": {
      "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
      "deliveryId": "01J...opaque"
    }
  }
}
```

Requirements:

- `messageId` is the deterministic observation value above;
- `receiptOrdinal` is a canonical positive decimal integer string assigned to
  this newly committed observation event under the vault-wide allocator below;
  it is immutable portable evidence, not an EventStore `ChangeToken`;
- `intentHash` and `plaintextHash` are computed under [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes);
- `localKeyName` is the exact local key that decrypted or verified the message;
- `peerResolutionEventId` is REQUIRED and names the exact `peer.resolved` used to
  authenticate the sender. It is null exactly for an anonymous observation,
  in which `did`, `presentedDid` and the derived peer key are also null.
  An authenticated or signed sender requires DID resolution evidence; there
  is no DID-less authenticated-key fallback. A non-null reference supplies
  the authenticated peer key under [section 4.1](#key-evidence); its `localKeyName`, `did` and
  `presentedDid` match this observation. Sender authentication and evidence
  reuse MUST satisfy [relationships.md sender freshness](relationships.md#sender-authentication-freshness)
  and [rules for duplicates and recovery](relationships.md#duplicate-authentication-and-historical-recovery).
  Commit/reuse that event and document first, then use its returned event ID
  in the separate inbound commit; later resolutions cannot replace the
  reference. It is local
  evidence metadata, excluded from the message hashes;
- `relationshipBindingEventId` is REQUIRED and nullable; it references the exact
  `relationship.bound` selected under [sections 6.1](#receipt-and-relationship-evidence) and [6.6](#relationship-fold-and-address-index). Obtain its `eventId`
  from a previously completed commit, as for `peerResolutionEventId`; it cannot refer
  to another draft in the inbound batch. Every authenticated proof-free
  observation has this reference, including a new birth receipt. Null is used
  for anonymous input and a carried proof whose existing
  relationship is still unresolved. The latter can obtain scope only through
  that carrier's verified `relationship.peerTransitioned`, never a new birth
  from its sender;
- `peerTransitionEventId` is REQUIRED and nullable. A proof-free peer successor
  references the already committed `relationship.peerTransitioned` that pins its
  canonical DID and successor document in the selected binding's `R`. A root sender or
  carried proof uses null. This rule is the same at every local address.
  The referenced edge must be valid; the observation's currently authenticated
  key must separately be authorized by that exact root/successor document for
  execution scope. An unknown key under a recognized DID keeps these references
  for the same-DID diagnostic, instead of inventing a new binding.
  Both references are immutable portable evidence, excluded from message hashes
  and wire headers. Choose them under the operation lock. Missing references
  defer, mismatches conflict, and import never infers a replacement from event
  timestamps. A carried proof with a non-null binding must validate in that
  same relationship before scope/ACK/effect work;

- `presentedDid` is the exact DID spelling disclosed on the wire, including a
  Peer DID long form when first seen;
- `did` is the canonical peer DID, using Peer DID numalgo-4 short form after
  validating the long form, or null when no peer DID is available;
- `createdTime`, `expiresTime`, `pleaseAck`, `ack`, `headers` and `fromPrior`
  preserve normalized wire headers; absent `please_ack` is null, a present
  array is retained exactly, absent `ack` is `[]`, and no additional header is
  `{}`;
- ACK processing expands `""` in `pleaseAck` to this `wireMessageId` and ignores only
  later duplicate targets; stored arrays are not rewritten;
- `headers` contains every otherwise-unmodeled permitted top-level member and
  MUST NOT contain any reserved field, including `return_route`;
- `thid`, `pthid` and `signedBy` are present with null when absent;
- event `author` identifies the active receiving runtime;
- mediation and delivery ID are null for direct transport without them;
- `bytes` is the canonical retained document byte length; and
- `attachmentCids` is the distinct ordered list of object-backed attachment
  payload roots in the closed stored document; link-only descriptors add no
  entry; and
- `roots` is the distinct ordered set of `bodyCid` followed by `attachmentCids`.

Every newly committed `message.in` receives its own fresh `receiptOrdinal`,
including a recorded duplicate or transition-verified alias of an existing message ID.
It MUST NOT copy an earlier observation's ordinal. Re-ingest of an existing
`eventId` preserves its event and allocates no new ordinal.

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
allocation, but restart, clearing local caches, or a new `replica_id` or
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

After `eventId` deduplication, distinct events with the same `(author,
receiptOrdinal)` are a receipt-integrity conflict. Affected logical messages
are those observed by the conflicting events. Retain those events and
surface the conflict; do not use affected logical messages as newly
frozen ACK targets. Unaffected messages remain processable. Full import MUST
NOT reject an event union merely for receipt-ordinal reuse or this projected
conflict. The generic event store remains payload-opaque. Its [section 5.3](event-store.md#ingest)
`ForkedAuthor` check detects unseen events under the current local author; it
does not prove that every historical author is fork-free.

The active runtime appends this event only after retained objects are durable.
Normal pickup ACK follows the dependent resolution, binding and inbound commits
in [distributed-delivery.md section 4.3](distributed-delivery.md#receive-a-message).
Pre-receipt deferrals follow [relationships.md section 9.1](relationships.md#deferred-delivery)
and produce no `message.in` or pickup ACK. That definition and its linked
[resolution-accounting rules](relationships.md#shared-accounting-and-lost-wait-state)
govern wait/retry scheduling; [section 6.1](#receipt-and-relationship-evidence)
governs missing relationship evidence and pending-pair claims. Carriers allowed
to commit with a null binding still follow durable receipt before pickup ACK.
Safely classified terminal input, including sender-resolution exhaustion,
MUST instead be pickup-ACKed without `message.in` under
[relationships.md sections 9.2](relationships.md#hard-pre-vault-gate)–[9.3](relationships.md#integrity-checks-and-durable-receipt).
This exception cannot bypass durable receipt for input that passes those checks.

<a id="duplicate-transition-and-conflict-rules"></a>

### 10.3 Duplicate, transition and conflict rules

First group observations by deterministic `messageId`.

Within one message ID:

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

Within one unique validated relationship scope, two authenticated message ID groups
with the same `wireMessageId` are one logical message only when:

1. their authenticated peer DIDs/keys are authorized by the same pinned
   document, or joined through verified relationship-scoped transitions,
   under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity);
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

It is a control observation under [section 10.6](#inbound-message-and-execution-fold). Invalid empty-message variants
are not treated as pure ACKs.

Anonymous senders can intentionally reuse wire IDs, so applications SHOULD
apply stricter replay and automatic-handling policy to them.

<a id="pickup-versus-ultimate-acknowledgment"></a>

### 10.4 Pickup versus ultimate acknowledgment


Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; each target in its validated `ack` array is resolved only as
`(carrier logical peer scope, wireMessageId)`. A conflict-free local outbound in that
same relationship scope may produce an
idempotent `delivery.acknowledged`. A wire ID reused by another peer or
relationship is never selected. Outbound membership is derived by [section 9.8](#outbound-message-and-delivery-fold). A threaded or natural response without an explicit `ack` array does not
create that delivery observation.

<a id="complete-observation-witnesses"></a>

### 10.5 Complete observation witnesses

For a claim about received evidence, its **complete observation witnesses** are
all committed `message.in` candidates that each satisfy every per-observation
requirement of the consuming schema or fold. Evaluate the required fields and
their exact referenced evidence against one observation at a time. A check
MUST NOT combine a field from one candidate with a field from another. The
result is the set of all complete matches, independent of enumeration order.

The consumer defines the candidate set and its required comparisons and
validation. `ackMessageId` in [section 9.7](#delivery-acknowledged) and `messageId` in [section 6.4](#relationship-peertransitioned) each
restrict candidates to that observation message ID's group. Any complete
matching duplicate can witness the claim; it does not pin a new exact event
reference. Exact references already required by the schema must still match as specified.
Rules for explicit `sourceEventId` references remain unchanged.

This matching rule does not replace authentication, scope, historical
membership, proof or group-validity checks. A matching candidate cannot clear
a group conflict or bypass a missing-evidence deferral required by the
consuming schema or fold. Incomplete evidence is not a proven mismatch merely
because the candidate cannot yet enter the witness set.

Subject to those checks, an existential claim requires at least one complete
witness. If the consumer defines an aggregate, apply it to all qualifying
witnesses, not only one selected for a lift. In particular, [section 9.8](#outbound-message-and-delivery-fold)
aggregates ACK receipt time across duplicates and distinct ACK carriers.

<a id="147-inbound-message-and-execution-fold"></a>

<a id="inbound-message-and-execution-fold"></a>

### 10.6 Inbound message and execution fold

First group `message.in` by deterministic observation `messageId`.

For each message ID group:

- equal `intentHash` values form one observation group;
- collect every distinct valid plaintext hash, receiving `localKeyName`/`peerResolutionEventId`,
  `receivedVia` and author observation;
- different intent hash is an intent conflict, whether application content
  or immutable control headers differ;
- every package-level address and security proof validates independently;
- erasure is applied before object presence; and
- conflict suppresses automatic effects and disputed ACK processing.

Derive scopes per observation and check row and message ID-group consistency under
[distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) before union.
[relationships.md section 9.3](relationships.md#integrity-checks-and-durable-receipt) rejects new superseded-sender input at receive time;
committed observations are never re-evaluated against later transitions.
Their historical scope and existing unfinished work do not depend on today's
current peer end. This does not bypass the ordinary evidence/conflict checks.
An unresolved observation defers the whole group; distinct relationship
scopes in the same message ID group conflict under that rule. Neither case
permits per-observation execution or ACK processing.

Union authenticated message ID groups into one logical message only when they have
the same wire ID, resolve to the same unique validated relationship scope,
have sender DID/key pairs authorized by the same pinned snapshot or connected
by verified scoped transitions under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity),
and agree on intent hashes with valid package evidence.
This is the only cross-peer-key wire-ID merge.

Each resulting conflict-free logical group uses its derived execution ID under
[distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) for ACK processing and automatic effects.

A **control observation** is one of:

- a conforming pure ACK under [section 10.3](#duplicate-transition-and-conflict-rules);
- a valid Empty address-change notification with a validated `from_prior`,
  empty body/attachments and headers permitted by the Empty protocol;
- a valid protocol-correlated Empty response or Trust Ping `ping-response`
  in the same R, whether or not it carries a rotation proof; or
- a valid no-response error under [relationships.md section 13](relationships.md#remote-errors-and-integrity-failures), with null
  `fromPrior` and `pleaseAck`, valid protocol content and authenticated R scope.

Control input remains durable and may form a binding, validate a transition,
confirm an exact local successor or process permitted explicit/asked-for ACKs.
No-response errors generate no reply. Control input is excluded from content
threads, unread counts, notifications and application-content handlers; remote
error diagnostics follow [section 7.6](#contact-fold). An ordinary Trust Ping request remains
application input even when it is the first message.

Classification is the same at every local address. A type string alone does
not hide an invalid control message or make it executable. Empty, ping-response
and Report Problem that fail these predicates still cannot trigger automatic
contact creation or early-privacy rotation under [relationships.md section 11](relationships.md#early-private-address-policy-and-notifications).
Valid generic receipt ACKs do not request further ACKs. Binding is independent
of these display and automatic-response policies.

A user-visible thread contains each remaining logical application message once,
positioned by the earliest canonical observation unless its application
protocol defines another display time.

<a id="13-automatic-effects"></a>

<a id="automatic-effects"></a>

## 11. Automatic effects

[distributed-delivery.md section 11](distributed-delivery.md#automatic-effects) defines effect identity and commit ordering;
[section 8.2](distributed-delivery.md#deterministic-pure-ack) there owns the pure-ACK vector. [Section 9.1](#ids) of this document defines
outbound ID derivation. [relationships.md section 11.1](relationships.md#automatic-response-selection) owns the
rotation-notification vectors; its [section 13](relationships.md#remote-errors-and-integrity-failures) defines remote error handling.

<a id="15-erasure-and-collection"></a>

<a id="erasure-and-collection"></a>

## 12. Erasure and collection

<a id="151-messageerased"></a>

<a id="message-erased"></a>

### 12.1 `message.erased`

```json
{
  "type": "message.erased",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "dropCids": ["bafkrei...body", "bafkrei...attachment"],
    "because": "user"
  }
}
```

`because` is `user`, `contact-deleted` or another stable policy code.
`dropCids` contains roots named by one or more events for the message.
They are names to release and therefore MUST NOT appear in the erase
event's `roots`.

Erasure is global and permanent for that message/root relation. Object
bytes may remain because another message or event retains the same exact CID.
The erased message still reads erased.

<a id="152-reading-content"></a>

<a id="reading-content"></a>

### 12.2 Reading content

For a message root:

1. if any `message.erased` for the message names the root, state is
   **erased** regardless of object presence;
2. otherwise, if every required object is present, content is available;
3. otherwise, if the local view explicitly permits partial object availability,
   state may be **not yet fetched**; and
4. otherwise state is **missing or damaged**.

Missing bytes MUST NOT be displayed as intentional deletion.

<a id="153-held-roots"></a>

<a id="held-roots"></a>

### 12.3 Held roots

Under the operation lock in [event-store.md section 10](event-store.md#vault-interface), the vault runtime computes
the held roots passed to `ObjectStore.collect` in [dasl-objects.md section 8.3](dasl-objects.md#collection).

A root is held when at least one accepted event retains it through
`event.roots`, except that a root named by `message.erased` is no longer held
by that message.

This section is the sole normative owner of prepared-envelope retention.
For a consistent outbound `M` and valid package `P`, define:

```text
retainEnvelopeForMessage(M, P) =
    !erased(M, P.envelopeCid)
    and !submitted(M)
    and !retired(P)
    and !packageTerminalFailure(P)
    and !messageTerminalFailure(M)
```

Terminal failure means valid committed `delivery.failed` at the
specified scope; a committed expired failure is message-terminal. Sampling wall
time beyond expiry blocks unsubmitted work but MUST NOT release its envelope
until that durable termination is committed. `submitted(M)` is defined by
[section 9.8](#outbound-message-and-delivery-fold) and remains true after envelope collection or package retirement.
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

<a id="154-no-runtime-local-eviction-event"></a>

<a id="no-runtime-local-eviction-event"></a>

### 12.4 No runtime-local eviction event

Version 3 does not represent local body eviction as a portable event. A local
storage policy that deletes a non-erased retained object makes the phase-1
vault incomplete. It may be repaired from a verified portable SQLite import or backup.
Deferred `vault-sync/1.0` may later provide another repair source. Local
absence never authorizes collection elsewhere.

<a id="16-procedures"></a>

<a id="procedures"></a>

## 13. Procedures

Address selection and binding are defined in [relationships.md sections 8](relationships.md#ordinary-sending-and-birth-selection) and
[5.2](relationships.md#binding-and-contact-policy); all sending and receipt use [distributed-delivery.md sections 4.2](distributed-delivery.md#send-an-ordinary-message) and
[4.3](distributed-delivery.md#receive-a-message). These wire procedures and the runtime procedures below
define required ordering. Implementations may combine steps transactionally
but may not reverse the durability boundaries. Every instruction to append
an event below means `Vault.commit(objects, drafts)`, using an empty object
list when no new objects are needed; `Vault.events` is read-only.

<a id="161-open-the-writable-full-runtime"></a>

<a id="open-the-writable-full-runtime"></a>

### 13.1 Open the writable full runtime

1. acquire exclusive runtime ownership and open SQLite, allowing its required
   journal recovery;
2. follow [vault-sqlite.md section 8.1](vault-sqlite.md#create-open-and-close)'s
   version checks and any supported schema upgrade before validating the current
   schema, ready state, metadata and seed wrapper;
3. unlock or obtain the seed and verify its derived anchor before application
   writes;
4. validate local `replica_id` and `store_generation` and discard only unpublished
   staging. Normal reopen preserves local IDs; create and restore initialize
   fresh ones under
   [vault-sqlite.md section 8](vault-sqlite.md#ownership-and-lifecycle);
5. fold portable state and reconstruct committed held roots before permitting
   GC;
6. project receipt-integrity conflicts and recover the vault-wide ordinal
   high-water mark under [section 10.2](#message-in) before accepting a new inbound
   observation; cross-author ordinal reuse does not block open or import;
7. recover birth/binding work from queued intents and retained resolution
   evidence under [section 6.2](#relationship-bound), and enumerate committed receipts with unfinished
   contact policy, transition, notification, ACK or protocol work. Also enumerate
   missing profile lifts under [sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared) from eligible readable inbound
   sources and submitted outbound intents. Control input never becomes an
   early-privacy trigger merely through recovery;
8. reuse committed bindings, contact assignments, local successors/proofs and
   frozen triggers. Finish package retirement and repacking for eligible
   unsubmitted intents; rediscover replies previously blocked by the local
   sender gate. Apply ordinary erasure closure without replacing identities;

9. derive every required mediation account; and
10. independently start recipient reconciliation, account-scoped pickup, live
    delivery and eligible outbox work.

Recovery in steps 7–8 MUST NOT depend on mediator redelivery or a surviving
local queue. It reuses frozen ACK arrays, output intents and execution IDs;
submitted outbounds never resume, including deterministic responses whose
carriers are observed again. An outbound without `delivery.submitted` may
resume eligible work even when an earlier transport call might have succeeded;
it does not invent missing evidence or choose new response work merely
because a cache was lost. Missing or damaged objects, or missing proofs, keep
the affected work deferred. Protocol-defined external effects retain their
existing idempotency or explicitly at-least-once contract; this procedure makes
no exactly-once claim.

Phase 1 MUST NOT require `replica-mediation/1.0` or `vault-sync/1.0`. Failure of
one mediator MUST NOT prevent offline local vault use or communication through
other live DIDs and routes.

A server holding the seed follows exactly this procedure and is the one active
full runtime. A remote thin client without the seed does not.

<a id="162-establish-mediation"></a>

<a id="establish-mediation"></a>

### 13.2 Establish mediation

1. append `mediation.created` before the network request;
2. derive its vault-scoped account key;
3. perform ordinary Coordinate Mediation;
4. on grant, append `mediation.granted`;
5. reconcile desired recipient DIDs through Coordinate Mediation; and
6. append `mediation.selected` when policy chooses it for new mediated routes.

The phase-1 runtime uses ordinary account-scoped Message Pickup. It sends no
`replica_id` to the mediator. A network failure after step 1 leaves a retryable
intent, not a half identity.

<a id="163-create-a-communication-did"></a>

<a id="create-a-communication-did"></a>

### 13.3 Create a communication DID

1. choose a configured live route, creating it first when necessary;
2. choose a fresh UUIDv7 entity ID, or the deterministic early-privacy ID under
   [relationships.md section 5](relationships.md#symmetric-relationship-identity) when that policy applies;
3. derive the fixed authentication and key-agreement keys;
4. build and validate a Peer DID numalgo-4 document encoding those keys and route;
5. commit `did.created` with canonical short form, long form and `boundRouteId`.

There is no role field. A committed ID reuses its exact keys, document and route
after a crash; it cannot be recreated using a new route. A conflicting or retired
entity cannot be silently replaced. Registration of a mediated recipient must
be verified before disclosure. First disclosure uses the long form under
[relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile). Address allocation may prefer another mediator to
reduce linkability, but route choice does not establish a relationship.

<a id="164-disclose-an-address"></a>

<a id="disclose-an-address"></a>

### 13.4 Disclose an address

Create or select a live communication DID under [section 13.3](#create-a-communication-did). Reconcile its
bound route and verify recipient registration, then commit `did.disclosed`
and expose its long form by OOB, QR, file or another discovery transport.
Public discovery SHOULD select an address allocated for that purpose and avoid
exposing an address used privately. These are disclosure policies; the same DID
identity, receipt and binding rules apply to either choice.

The address belongs to the vault, not the process displaying it. A runtime
missing authoritative local key/route state leaves incoming delivery pending
until recovery repairs those prerequisites.

<a id="165-erase-a-message"></a>

<a id="erase-a-message"></a>

### 13.5 Erase a message

1. fold every root currently retained by the logical message and its prepared
   packages;
2. process-durably commit the erase event(s), preferably in one `Vault.commit`;
   and
3. run the locked held-root fold and collection under [section 12.3](#held-roots).

Late duplicate observations may introduce another event retaining the same
logical roots. The active runtime that observes an existing erase MUST append
an equivalent erase for newly learned roots of that message before those roots
are considered intentionally released. A future replicated profile applies the
same closure rule in every full copy.

<a id="166-delete-a-contact"></a>

<a id="delete-a-contact"></a>

### 13.6 Delete a contact

1. append `contact.deleted` for the exact `contactId`;
2. for every message exactly attributed to that contact, append erases for
   body, attachment and prepared-envelope roots required by policy;
3. retire communication DIDs required exclusively by that contact, preserving
   any address still needed by another relationship or public disclosure;
4. unregister their mediated bound-route pairs, retiring a reusable route only
   when no other live DID requires it;
5. preserve shared addresses unless independently retired; and
6. run the locked held-root fold and collection under [section 12.3](#held-roots).

A late message durably received under [section 5.5](#did-retired) and attributed to that
tombstoned contact requires the same idempotent cleanup procedure. It cannot
resurrect the contact or authorize a new response. A terminal recipient under
[relationships.md section 9.2](relationships.md#hard-pre-vault-gate) instead produces no new `message.in` to clean up.

<a id="167-rotate-a-local-relationship-address"></a>

<a id="rotate-a-local-relationship-address"></a>

### 13.7 Rotate a local relationship address

1. under the operation lock, identify one `R` and validate [section 6.5](#relationship-localtransitioned)'s rooted
   binding, assignment, predecessor and confirmation evidence;
2. choose a live configured route and create a fresh successor under [section 13.3](#create-a-communication-did); its route may differ from the predecessor's;
3. sample the rotation instant once, sign the predecessor-to-successor proof,
   and select the exact trigger only for section [11](relationships.md#early-private-address-policy-and-notifications) of [relationships.md](relationships.md)'s policy;
4. atomically commit the successor and `relationship.localTransitioned`,
   rechecking evidence under the lock; retire no predecessor or shared resource;
5. verify the successor's recipient registration before disclosure and resume
   ordinary sends, repacks and any trigger's notification using the stored edge;
6. derive confirmation from retained authenticated input at that exact successor,
   then permit retirement only of resources no other relationship/disclosure needs.

A crash before step 4 leaves no frozen successor; afterward recovery reuses
the exact committed DID, route, proof and trigger. It cannot create another
branch or regenerate `iat`. A manual/local rotation with null trigger SHOULD
queue a new ordinary Trust Ping with `response_requested: true` when no other
message will solicit qualifying input at the successor. Its response can
supply exact-successor confirmation under [relationships.md section 11.4](relationships.md#confirmation-and-overlap).
That local send decision is durable and follows the same submitted boundary.
The operation changes only one end of one `R`; public-to-private and later
private-to-private changes execute this same procedure.

<a id="17-merge-synchronization-and-restore"></a>

<a id="merge-synchronization-and-restore"></a>

## 14. Merge, synchronization and restore

<a id="171-event-merge"></a>

<a id="event-merge"></a>

### 14.1 Event merge

Merge is event-store union by `eventId`. It never:

- rewrites an event;
- removes another replica's decision;
- treats another author as read-only history; or
- adopts database pages or physical row order as authoritative state.

After merge, every fold reflects the complete union. A cached projection must
be updated or invalidated in the acceptance transaction and rebuilt before use
if invalid; an incremental result must equal the pure fold of that union.

<a id="172-object-merge"></a>

<a id="object-merge"></a>

### 14.2 Object merge

Compute held roots from the prospective event union and copy only valid absent
objects required by that fold. Full import publishes events and available
objects under [event-store.md section 11.3](event-store.md#import-into-an-existing-vault)'s complete-view boundary; this
semantic union is not permission to expose an intermediate event-only import.
No content traversal is implied. An erased message/root relation does not
revive merely because an older source still has the bytes.

Missing non-erased bytes remain an integrity/availability condition and may
be repaired from a verified portable SQLite import or backup. Deferred
`vault-sync/1.0` may later provide another repair source.

<a id="173-replica-synchronization-deferred"></a>

<a id="replica-synchronization-deferred"></a>

### 14.3 Replica synchronization (deferred)

`vault-sync/1.0` is a future profile for encrypted immutable root, event and
DASL-object anti-entropy. It is not required by phase 1 and MUST NOT be started
implicitly by a phase-1 runtime.

<a id="174-restore"></a>

<a id="restore"></a>

### 14.4 Restore

A portable SQLite restore creates a new local `replica_id` and
`store_generation`. An exact local move is a separate operation that may retain
them only with the old writer permanently stopped under
[vault-sqlite.md section 12.3](vault-sqlite.md#exact-local-move). The restored
runtime derives every mediation and communication key, reconciles required
recipients using ordinary Coordinate Mediation, drains the account-scoped
mailbox, and resumes eligible outbox work.
It also reconciles unfinished committed inbound work under [section 13.1](#open-the-writable-full-runtime),
including observations already pickup-ACKed before the snapshot. Local queue
state is not a recovery source.

No previous process must be online. Mediator retention still bounds messages
that were never committed to the vault. The seed recovery credential must be
retained independently of the active runtime; a portable SQLite backup includes
its encrypted wrapper. Recovery verification follows
[vault-sqlite.md section 4.2](vault-sqlite.md#recovery-material-and-product-requirement).

<a id="175-forked-author"></a>

<a id="forked-author"></a>

### 14.5 Forked author

If two writable copies accidentally preserve the same local replica ID,
previously unseen same-author events cause `ForkedAuthor`. One copy mints
a new local replica ID and retries merge. Existing events under the old
author remain unchanged.

<a id="18-privacy-and-security-boundaries"></a>

<a id="privacy-and-security-boundaries"></a>

## 15. Privacy and security boundaries

- Phase 1 has one active full runtime holding the single seed.
- A full runtime may run locally or on a server; process location does not
  confer ownership of a DID.
- `replica_id` and event author are operational provenance, not credentials or
  peer-visible addresses.
- Runtime and portable SQLite databases contain plaintext retained message
  content and attachments unless surrounding storage encrypts them.
- A rendezvous DID is intentionally disclosed and correlatable within its
  audience. Its Peer long form avoids DNS resolution for that DID; resolving
  an external peer or mediator may still involve a network resolver.
- Private-address allocation SHOULD disclose its new DID only in encrypted
  interaction and avoid publishing it in reusable discovery. This is policy,
  not a different relationship or authentication type.
- A valid `from_prior` is relationship-scoped evidence. It MUST NOT globally
  link or retire addresses used by other relationships.
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

<a id="19-versioning"></a>

<a id="versioning"></a>

## 16. Versioning

These event meanings belong to vault version 3. A version-3 reader may
preserve unknown event types but MUST validate every known type according
to this document.

Compatible additions within version 3 may introduce a new event type or
an explicitly optional payload field whose absence has a fixed meaning.
Changing the meaning of an existing field, fold, deterministic ID,
erasure rule or key derivation requires a new vault version.

There is no migration requirement from an earlier event vocabulary.

<a id="20-required-conformance-cases"></a>

<a id="required-conformance-cases"></a>

## 17. Required conformance cases


<a id="runtime-identity-ve-1-ve-2"></a>

### Runtime identity (VE-1–VE-2)

1. <a id="ve-1"></a> Every local event has `author == local replica_id` and phase 1 enforces one
   active writer.
2. <a id="ve-2"></a> A server full runtime has the same event semantics as a local full runtime;
   a thin client without seed is not an author.

<a id="outbound-intent-packages-and-acknowledgment-ve-3-ve-14"></a>

### Outbound intent, packages and acknowledgment (VE-3–VE-14)

3. <a id="ve-3"></a> A send commits body, attachments and `message.out` with networking disabled.
4. <a id="ve-4"></a> `message.out` freezes created time, expiry, exact nullable `pleaseAck`,
   exact `ack` and every permitted additional header.
5. <a id="ve-5"></a> Null `pleaseAck` omits the wire header; `[]` emits an empty header and
   requests no explicit message ID.
6. <a id="ve-6"></a> `pleaseAck` containing `""` or the current wire ID requests that message's
   receipt; an array naming only older IDs does not. Neither changes submission
   completion or envelope retention.
7. <a id="ve-7"></a> Standard `please_ack` empty-string and current-ID forms are accepted and
   preserved.
8. <a id="ve-8"></a> `return_route` is rejected in vault application headers.
9. <a id="ve-9"></a> Intent hash covers application ID/type/thread/body/ordered attachments and
   immutable control headers; plaintext hash covers one exact DIDComm
   plaintext.
10. <a id="ve-10"></a> Two packages may differ in valid address/security evidence while agreeing
    on wire ID and intent hash.
11. <a id="ve-11"></a> Retrying one package preserves identical plaintext, envelope and package
    ID.
12. <a id="ve-12"></a> HTTP success produces `delivery.submitted`, never acknowledgment.
13. <a id="ve-13"></a> A deterministic response acknowledges an outbound only when authenticated
    explicit `ack` names its wire ID.
14. <a id="ve-14"></a> Expiry irreversibly ends unsubmitted work. [Section 9.8](#outbound-message-and-delivery-fold) derives `late`
    from the earliest valid ACK carrier observation `at`, for both submitted
    and expired unsubmitted messages. An observation before expiry is on time;
    equality or later is late. Null expiry is never late. Restart, fold time,
    a later duplicate and delayed `delivery.acknowledged` commit do not change
    an on-time receipt into a late one. No expired failure is needed for a
    submitted message's late receipt.

<a id="inbound-scope-execution-and-receipt-ve-15-ve-25"></a>

### Inbound scope, execution and receipt (VE-15–VE-25)

15. <a id="ve-15"></a> Equal authenticated variants derive one observation message ID. Equal wire IDs
    under transition-verified peer keys in one relationship merge only at the
    logical-message layer.
16. <a id="ve-16"></a> Execution ID derives from the unique symmetric relationship scope and wire
    ID using previously committed evidence, never a key pair, contact,
    observation message ID or uncommitted transition.
17. <a id="ve-17"></a> A transition-pending observation is effect-deferred; once verified, a
    cross-key alias in the same relationship derives the same execution ID.
18. <a id="ve-18"></a> Observations sharing one message ID but deriving different scopes preserve prior
    history and suppress ACK processing and new effects as an execution-scope
    conflict; different valid local recipient keys cannot cause two executions.
19. <a id="ve-19"></a> Intent conflicts suppress disputed automatic effects and ACK
    processing.
20. <a id="ve-20"></a> Pure ACK, valid Empty rotation notification, protocol-correlated
    Empty/ping-response and no-response errors obey [section 10.6](#inbound-message-and-execution-fold) at every
    address. Their permitted ACK/transition work remains; they create no
    contact or recursive privacy notification. Trust Ping requests remain
    application input.
21. <a id="ve-21"></a> Pure ACK has `pleaseAck == null`; it completes when `delivery.submitted`
    commits under the common rule and creates no ACK loop.
22. <a id="ve-22"></a> Duplicate receipt of a message whose requested IDs were already honored
    may resume eligible unsubmitted work from the same frozen response/ACK
    intent. After that intent's `delivery.submitted`, it causes no resubmission
    or replacement effect.
23. <a id="ve-23"></a> Account-scoped Pickup ACK follows durable message/object commit for
    input passing receive and integrity checks.
24. <a id="ve-24"></a> Unlock/recovery and recoverable exact-method prerequisites defer without
    pickup ACK. Missing/pending relationship evidence under [section 6.1](#receipt-and-relationship-evidence) also
    defers receipt when required by that section, without message.in or pickup
    ACK; it retries on relevant evidence changes under [relationships.md section 9.1](relationships.md#deferred-delivery). The wait consumes no sender-resolution budget and has no local retention
    timeout; retry uses [relationships.md section 10.1](relationships.md#did-resolution-requirements)'s fresh bounded resolution
    sequence when needed, excluding waiting time from its local retention stop.
    Foreign/nonexistent/wrong-purpose methods, unbound retired
    addresses and terminal routes are terminal. A retired address in a bound
    local history still receives while its route is eligible; tombstoned
    contact input is cleaned up without new effects.
25. <a id="ve-25"></a> Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.

<a id="peer-evidence-and-relationship-formation-ve-26-ve-37"></a>

### Peer evidence and relationship formation (VE-26–VE-37)

26. <a id="ve-26"></a> `peer.resolved` retains exact canonical document bytes under their raw CID,
    presented/canonical DID forms and selected key IDs, including for external
    `did:web` peers.
27. <a id="ve-27"></a> Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
28. <a id="ve-28"></a> Public discovery uses a chosen communication address under disclosure
    policy. Private allocation is not a different DID schema or receive path.
    Local Peer discovery needs no DNS.
29. <a id="ve-29"></a> Valid first and later inputs have no initial-specific type, size, lifetime
    or acceptance-time policy. Authentication, integrity and resource checks
    remain.
30. <a id="ve-30"></a> Trust Ping is supported; unknown application types and missing receipt
    requests do not prevent durable receipt or relationship binding.
31. <a id="ve-31"></a> The first message uses its ordinary application protocol with no custom
    rendezvous wrapper or wire relationship ID.
32. <a id="ve-32"></a> Every proof-free authenticated observation references a common
    relationship binding; its exact local key and peer resolution validate
    membership. Root and successor inputs use the same rules on public and
    private addresses.
33. <a id="ve-33"></a> Repeated sends and opposite first sends between the same two canonical
    addresses derive one R independently of sender direction, selected
    document key, wire ID and allocation policy.
34. <a id="ve-34"></a> A contact tombstone and its relationship assignment survive rediscovery. A
    genuinely new relationship requires a fresh address pair, not another key
    selected from the same pinned DID.
35. <a id="ve-35"></a> First receipt accepts absent or past wire expiry. Outbound expiry
    independently stops unsubmitted work at equality.
36. <a id="ve-36"></a> Durable receipt survives restart before contact policy or rotation work.
    Recovery needs no redelivery or new admission decision; current tombstones
    still suppress effects.
37. <a id="ve-37"></a> relationship.bound contains only R, root local DID and exact peer
    resolution. Contact assignment and local transition are separate events.
    Equivalent root document references deduplicate; incompatible pins
    conflict.

<a id="address-changes-and-default-responses-ve-38-ve-49"></a>

### Address changes and default responses (VE-38–VE-49)

38. <a id="ve-38"></a> Local `from_prior.iss` uses the predecessor's long form and its protected
    `kid` has that exact DID portion. Peer verification matches validated
    predecessor spellings and method IDs under [section 6.4](#relationship-peertransitioned), without changing
    the pinned snapshot or JWT bytes.
39. <a id="ve-39"></a> `from_prior.sub` equals plaintext `from` byte-for-byte; before confirmation
    both use the successor's Peer-DID long form.
40. <a id="ve-40"></a> The receiver verifies a rotation's `iss` and protected `kid` against its
    binding's exact pinned predecessor snapshot and accepts any integer
    Epoch-Seconds `iat`; neither `iat` nor a fresh resolver result selects a
    snapshot ([relationships.md section 12](relationships.md#peer-address-changes)).
41. <a id="ve-41"></a> Successor/edge evidence commits before disclosure and registration is
    verified before first disclosure. Exact notification intent and package
    commit before their network submission.
42. <a id="ve-42"></a> Trust Ping is the default no-content initial message; an application
    message may be first without wrapping.
43. <a id="ve-43"></a> An early-privacy notification uses the trigger execution and one eligible
    ACK selection, requests its own ACK and gets the current local proof at
    preparation. Generic pure ACK never requests an ACK.
44. <a id="ve-44"></a> Human-authored content may use the current public or private address
    before/after rotation. It does not select birth identity or regenerate
    rotation time.
45. <a id="ve-45"></a> Until exact-successor confirmation, every new package from that successor
    uses the frozen proof and long form; root senders need no proof.
46. <a id="ve-46"></a> Known terminal integrity rejection creates no message.in or response.
    Retained valid input uses ordinary erasure rules.
47. <a id="ve-47"></a> A root public sender enters ordinary sending without a qualifying first
    reply or handoff. All target intents freeze one R; no contact/address
    preference substitutes another relationship at preparation.
48. <a id="ve-48"></a> Relationship-scoped transition does not globally retire or union the rendezvous
    DID with unrelated relationships.
49. <a id="ve-49"></a> Peer rendezvous and relationship DIDs may use different mediation routes.

<a id="lifecycle-erasure-and-restore-ve-50-ve-55"></a>

### Lifecycle, erasure and restore (VE-50–VE-55)

50. <a id="ve-50"></a> Desired registration includes live DID/route pairs. A retired address in
    existing relationship history retains its receiving mediation while that
    route remains usable; allocation/disclosure policy never changes these
    sets.
51. <a id="ve-51"></a> Each local DID derives fixed authentication and key-agreement keys and
    an immutable bound route. Rotation creates another entity; the local
    allocator selects its independent route when creating the successor DID.
52. <a id="ve-52"></a> Erasure is checked before object presence; late roots receive equivalent
    erasure closure.
53. <a id="ve-53"></a> Restore from portable SQLite creates a new local author, reconciles standard
    mediation/pickup and resumes eligible outbox work; an exact local move follows
    its separate stopped-source rule.
54. <a id="ve-54"></a> Phase 1 requires neither `replica-mediation/1.0` nor `vault-sync/1.0`.
55. <a id="ve-55"></a> Shuffling the same event set leaves every phase-1 fold result unchanged.

<a id="commit-ack-and-retention-regressions-ve-56-ve-72"></a>

### Commit, ACK and retention regressions (VE-56–VE-72)

56. <a id="ve-56"></a> Closed attachment normalization makes intent hashes independent of
    implementation-selected presentation or diagnostic metadata.
57. <a id="ve-57"></a> ACK before `delivery.submitted` does not complete submission or release an
    otherwise retained package. Committing `delivery.submitted` releases every
    package's delivery retention contribution for that message ID without waiting for
    ACK; message body and attachment lifetimes remain separate.
58. <a id="ve-58"></a> Commit and collection share the operation lock; GC computes current held roots
    under that lock and cannot delete a retained object or overlap acceptance
    and append within a commit.
59. <a id="ve-59"></a> A successfully appended inbound event survives immediate process restart
    before the mediator pickup acknowledgment is sent.
60. <a id="ve-60"></a> ACK lookup uses the carrier relationship scope and wire ID. Another
    relationship with the same wire ID is never acknowledged.
61. <a id="ve-61"></a> Every accepted inbound carries a durable phase-1 receipt ordinal. ACK arrays
    use `firstReceiptKey`; clock rollback does not reverse receipt order in a
    linear history, and cross-author ties have deterministic recovery order.
62. <a id="ve-62"></a> The common binding is created from either incoming authentication or an
    outgoing birth selection after resolution. It precedes first package
    preparation and effect execution. Restart, erasure and submission preserve
    the same root/document evidence; missing references defer and mismatches
    conflict.
63. <a id="ve-63"></a> Later transition-verified aliases/rotations in that relationship reuse the
    same execution ID and cannot execute the same logical wire message twice.
    Contact decisions or DID/route retirement never select a new execution scope.
64. <a id="ve-64"></a> Committed submission remains complete after restart, loss of local caches,
    clock rollback, package retirement, content erasure and envelope collection.
    Retained event skeletons prevent resubmission or replacement of that message ID.
65. <a id="ve-65"></a> One package's committed `delivery.submitted` completes its entire message ID and
    suppresses every other package's preparation or submission. Workers
    serialize dispatch per message ID and commit acceptance before further dispatch.
66. <a id="ve-66"></a> The inbound message ID vectors in [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) recompute to
    `369d7a43-8dce-5b86-b073-e390d457f357` and
    `a8b9afd5-60fe-5f49-a669-bd998e760e7e` from their published inputs.
67. <a id="ve-67"></a> Attachment IDs obey DIDComm 2.1 URI-unreserved syntax independently of
    filename or DASL object identity.
68. <a id="ve-68"></a> An otherwise retained unsubmitted package survives route unavailability
    and GC with its exact bytes. Route recovery cannot reopen a submitted message ID.
69. <a id="ve-69"></a> Retiring an unsubmitted package releases its delivery retention contribution
    without completing the message ID. Retiring a submitted package does not undo the
    message ID's committed submission evidence.
70. <a id="ve-70"></a> Shared envelope bytes remain held by another non-erased message even after
    one message/root relation is erased.
71. <a id="ve-71"></a> Each new duplicate observation receives a fresh ordinal; exact re-ingest
    does not. The logical group's minimum complete `(integer ordinal, author)`
    key orders future ACKs without changing any already frozen ACK array.
72. <a id="ve-72"></a> Restore, restart and loss of local caches recover the ordinal high-water mark
    across all historical authors. Cross-author equal ordinals survive import
    and sort by author on a tie; allocation resumes above the union's maximum.

<a id="invitation-duplicate-and-recovery-regressions-ve-73-ve-89"></a>

### Invitation, duplicate and recovery regressions (VE-73–VE-89)

73. <a id="ve-73"></a> Matching root-address receipt consumes a local one-use invitation at input
    commit, before contact or rotation work. A different consumer fails
    integrity; crash, deletion and erasure never reopen it.
74. <a id="ve-74"></a> ACK membership joins immutable outbound relationshipId, birth metadata,
    binding and package endpoint evidence. Equal inbound/outbound wire IDs alone
    cannot acknowledge another message.
75. <a id="ve-75"></a> A known sender DID or submitted message ID does not bypass missing
    binding/transition recovery. Required scope evidence commits before a
    separate response-intent commit.
76. <a id="ve-76"></a> A pickup-ACKed inbound with unfinished deterministic work is rediscovered
    from portable history on open, without redelivery or a surviving local queue.
77. <a id="ve-77"></a> A known duplicate can record a new receipt observation but cannot
    recreate a tombstoned contact. A conflicting duplicate supplies no new
    executable work; its prior history remains.
78. <a id="ve-78"></a> A valid no-response error uses the common relationship scope and generates
    no reply. Its explicit ACK proves receipt only, and later rotation does
    not erase its historical scope.
79. <a id="ve-79"></a> Crash after receipt recovers contact policy, selected rotation trigger and
    unfinished protocol effects without redelivery. An existing response
    selection cannot be rewritten to become a notification.
80. <a id="ve-80"></a> Distinct events sharing a receipt `(author, ordinal)` pair remain history
    with a projected receipt-integrity conflict, not a full-import failure.
    Only affected logical messages are excluded from newly frozen ACK targets.
81. <a id="ve-81"></a> Every permutation of a fixed event union yields the same minimum complete
    receipt key and scope-local order. Learning an older verified alias may
    change future order, never a previously frozen ACK array.
82. <a id="ve-82"></a> Authenticated receipt binds a new live address pair without a message-type
    or private-address admission rule. Unknown types need no approval;
    missing/conflicting continuation cannot fall back to a birth.
83. <a id="ve-83"></a> Same-consumer invitation reuse does not create another take. Imported
    incompatible consumers leave it unavailable; event order chooses no winner.
84. <a id="ve-84"></a> Adding `contact.merged` changes only display grouping. Per-`contactId` decisions,
    relationship scopes, message/execution IDs, ACK results, invitation state
    and deletion/erasure behavior remain unchanged.
85. <a id="ve-85"></a> Matching pthid alone, a foreign local recipient, remote invitation or
    continuation cannot consume our disclosure. A root-address receipt can
    consume another invitation for its existing R.
86. <a id="ve-86"></a> Retryable transport failures and attempt phase/status remain local trace.
    Restoring an outbound with only `message.out` projects `queued` and permits
    eligible retry; durable prepared/submitted/terminal evidence still applies.
    A crash before `delivery.submitted` commits may resend the exact package
    even if transport had accepted it; a crash after commit cannot resend it.
87. <a id="ve-87"></a> A user send or deterministic response uses its outbound message ID as plaintext
    `id`; every package and retry preserves it. Inbound observation message IDs remain
    scoped derivations and are not replaced with the received wire ID.
88. <a id="ve-88"></a> A successor freezes its own route at DID creation. Crash before commit may
    choose again; afterward recovery reuses that exact document and route.
    Preference changes do not edit it.
89. <a id="ve-89"></a> Retirement and input commit serialize under the operation lock. Retired
    addresses accept existing-history receipt but no new births, independent
    of public/private policy. Historical receipt and invitation consumption
    survive import without a clock cutoff.

<a id="transition-evidence-and-automatic-intent-ve-90-ve-100"></a>

### Transition evidence and automatic intent (VE-90–VE-100)

90. <a id="ve-90"></a> A peer transition names one R, exact local recipient, retained predecessor
    and authenticated successor carrier. Shared contact, prior DID, key or
    thread alone cannot extend a relationship.
91. <a id="ve-91"></a> Erasure preserves bound roots, peer document references, local edge/JWT
    and notification trigger. Missing evidence defers; invalid proof fields
    never select replacement material.
92. <a id="ve-92"></a> Two automatic intents for the same execution, handler, kind and ordinal
    have one effect key and message ID. Different intent hashes conflict after any
    permutation of their union; both variants and their packages remain history,
    with preparation and submission suppressed.
93. <a id="ve-93"></a> Equal effect keys and intent hashes with different relationshipId values
    still conflict. Exact duplicate intents produce one logical outbound.
94. <a id="ve-94"></a> An automatic intent whose execution ID disagrees with its unique carrier
    group's derived ID, whose key disagrees with that ID or protocol tuple, or
    whose message ID disagrees with its key is invalid and cannot execute.
95. <a id="ve-95"></a> Every automatic `message.out` retains `handlerId`, `effectKind` and the
    canonical decimal `ordinal` with its execution ID and key. Reopen can
    recompute the key from those fields; a missing or altered tuple component
    cannot authorize work. A user-authored send has all five fields null and
    `ack == []`; a non-empty ACK cannot bypass deterministic effect selection.
96. <a id="ve-96"></a> After an ACK-bearing response is frozen, a changed handler, effect kind or
    ordinal cannot create another ACK-bearing message ID for that execution, even
    after submission or erasure. Importing competing response message IDs keeps
    their history and suppresses all competing responses under every event
    permutation; exact duplicates count once.
97. <a id="ve-97"></a> A valid no-response rejection with a unique pinned-document and thread
    match shows its retained reason beside only that outbound. Explicit
    ACK adds receipt information; with or without ACK, committed
    `delivery.submitted` stops submission and its absence leaves the existing
    unsubmitted-work rules in force. Duplicate observations show one
    diagnostic, and permutations give the same report order. A report naming
    several ACK targets does not reject them all; ambiguous correlation shows
    no attempt diagnostic. Restart reconstructs the view, body erasure removes
    the diagnostic even if its CID remains elsewhere, and a delayed report
    never overrides an established relationship.
98. <a id="ve-98"></a> An authenticated supported public DID binds and communicates normally
    without Peer-specific spellings. Local private-address allocation is
    optional policy and uses an ordinary local transition.
99. <a id="ve-99"></a> A direct reply on the pinned DID and a later valid rotated alias of the
    same wire message have one relationship execution ID. Reopen, duplicate
    input and another send do not replace the binding or repeat
    effects; committed submitted outbounds remain complete.
100. <a id="ve-100"></a> A proposed binding/input/transition cannot authorize its own response in
     the same batch. Commit scope evidence first; a rotation trigger and its
     required response are recovered through separate committed dependencies.

<a id="key-binding-and-resolution-regressions-ve-101-ve-111"></a>

### Key, binding and resolution regressions (VE-101–VE-111)

101. <a id="ve-101"></a> Key encoding normalization still governs authentication,
     observation message IDs and key membership. Relationship IDs instead use
     canonical DID strings; selected keys do not enter them. The X25519
     fixture round-trips its type code and public bytes.
102. <a id="ve-102"></a> First-disclosure validation and recovery use the complete keys and
     presented DID evidence in message/resolution events. Selecting a recipient
     key or assigning a relationship to a contact does not prove authenticated
     inbound traffic. Anonymous, mediator and relationship-pending observations
     retain their key evidence without an application execution scope.
103. <a id="ve-103"></a> message.out stores required non-null relationshipId directly alongside
     nullable birth. Both are immutable portable metadata outside wire hashes;
     different values under the same messageId still conflict when intentHash
     agrees. Birth selection permits offline queueing and must agree with a
     later binding. Packages may follow valid rotations without changing these
     fields.
104. <a id="ve-104"></a> Every new address pair uses one common binding type. No first reply is
     required for ordinary sending. Queued births remain identifiable after
     reply, submission, erasure or restore without reconstructing
     classification from OOB or message type.
105. <a id="ve-105"></a> A successful same-DID resolution with no usable previously evidenced key
     produces only message-scoped `peer-key-changed`, with no incompatible
     package or binding. An authenticated same-DID new-key inbound without
     proof at the old relationship DID stays unscoped and out of the thread,
     unread count and normal notifications. Its contact diagnostic survives
     restart and body erasure; contact assignment never authorizes its ACKs or
     effects. Missing or ambiguous relationship evidence selects no contact.
106. <a id="ve-106"></a> The peer chain includes every key-agreement key in the pinned initial
     document and each verified successor document. A second authorized key
     can reply in the same scope without an origin rewrite; a fresh unpinned
     document cannot add a key. Equal wire messages under these keys merge
     once within that relationship when their intent and package proofs agree.
107. <a id="ve-107"></a> The relationship-ID vector uses sorted canonical birth DIDs in both
     directions. NIST JWK/SEC1 key normalization still applies to
     authentication evidence but cannot change R.
108. <a id="ve-108"></a> First-package preparation for each new non-numalgo-4 outbound performs
     fresh resolution. Retry and permitted repack use retained evidence;
     neither an old snapshot nor a local TTL bypasses the new-message ID rule.
     Every new non-numalgo-4 inbound observation also requires current sender
     authentication under [relationships.md section 10.1](relationships.md#did-resolution-requirements); a chain member absent
     from the current document fails, and unavailable resolution defers
     without pickup ACK only within that section's per-delivery budget.
     Exhaustion is terminal input with pickup ACK and no `message.in`, without
     timing out recoverable local key/route/evidence state.
     Committed observations recover from their retained evidence without new
     resolution or retroactive scope changes.
109. <a id="ve-109"></a> Control input may establish a binding and process scoped ACKs but creates
     no contact or early-privacy transition, including during recovery.
     Invalid control-shaped types are not hidden and cannot trigger privacy
     notifications.
110. <a id="ve-110"></a> An input received at an eligible retired local relationship DID retains
     scope and durable receipt. Without a usable current local end it commits
     no deterministic reply/ACK intent and consumes no ACK-bearing selection.
     Creating a valid live successor makes that unfinished work recoverable;
     it replies in the same relationship, never another one of the contact.
111. <a id="ve-111"></a> `message.in` and `message.prepared` have no `peerPublicKey` payload member.
     Message IDs and package comparisons derive it through `peerResolutionEventId`.
     Missing non-null references defer, mismatched evidence conflicts, and only
     an anonymous inbound has null resolution/peer key. Resolution, peer-transition
     and ACK event keys remain present; profile observations reference source
     messages instead of copying their keys or wire IDs.

<a id="local-rotation-and-relationship-histories-ve-112-ve-124"></a>

### Local rotation and relationship histories (VE-112–VE-124)

112. <a id="ve-112"></a> A local edge atomically freezes a fresh successor, exact JWT and nullable
     notification trigger. Ordinary rotations use UUIDv7; automatic first
     private allocation may use the endpoint-specific deterministic ID. Root R
     and peer history stay unchanged.
113. <a id="ve-113"></a> Before a local edge, the predecessor's disclosure is confirmed by scoped
     inbound at that exact DID. A direct reply from the pinned original
     rendezvous or public peer DID qualifies without a peer rotation.
     A second local edge waits for confirmation of the first and uses that
     successor's long form and signing
     key as predecessor; short-form traffic does not replace the proof pin.
114. <a id="ve-114"></a> Until successor confirmation, new packages use its long form and exact
     frozen proof. Receipt at a predecessor cannot confirm it; a pure ACK at
     the successor can, independently of which outbound it explicitly ACKs.
     The rotating operation keeps a previously live predecessor and its route
     and mediation through confirmation, without retiring shared resources.
     A manual rotation with no other message soliciting confirmation SHOULD
     queue an ordinary Trust Ping with response_requested true.
115. <a id="ve-115"></a> Every unsubmitted R-targeted intent, including birth intents, repacks
     after a local edge with the same message ID, intent and ACK targets. Old
     packages stop immediately, before cleanup observations; submitted message IDs
     never reopen and no old-address fallback is allowed.
116. <a id="ve-116"></a> Duplicate local edges are idempotent; branches, cycles and incompatible
     evidence conflict in every import order. Missing prefixes defer. Sharing
     a DID alone is not a conflict.
117. <a id="ve-117"></a> Local predecessor and successor keys retain the same relationship scope
     and outbound ACK membership under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity)'s
     local-rotation vector. A contact preference cannot attach an unrelated
     local DID to that chain or make an automatic response cross relationships.
118. <a id="ve-118"></a> A shared local root or successor can occur in multiple Rs. Only competing
     claims on the same local/peer address pair conflict; imports retain both
     without merging IDs or selecting an event-order winner.
     The index contains every historical local/peer combination, including
     intermediate nodes when both chains have rotated more than once.
119. <a id="ve-119"></a> A peer proof received at any historical local address, including the
     root, extends the same R. The root already belongs to localChain.
     Proof-free successor receipt pins its binding and exact peer transition.
120. <a id="ve-120"></a> Recovery between input and peer-transition commits supplies no
     provisional birth scope. Once validated, the same R applies at root and
     successor local addresses, after erasure and in every import order.
121. <a id="ve-121"></a> relationshipBindingEventId and peerTransitionEventId are immutable receipt evidence,
     never wire fields or hash inputs. Missing references defer; competing
     birth/continuation claims conflict without moving prior effects or
     releasing invitation consumption.
122. <a id="ve-122"></a> Fold crossed changes of opposite ends in either order: both produce A1/B1
     in the same birth R. Same-end competing successors remain conflicts.
123. <a id="ve-123"></a> Contact assignment can precede resolution for an offline birth and is
     independent of the binding. Control-only R has no contact; conflicting
     assignments never change cryptographic scope.
124. <a id="ve-124"></a> A notification trigger names the eventId of one committed qualifying application
     observation with no prior response selection, even when duplicates share
     its messageId. Repeated edge evidence cannot substitute another observation's
     eventId. Its response is recovered exactly once, using the normal
     automatic-effect tuple and submitted boundary.

<a id="recipient-eligibility-and-evidence-recovery-ve-125-ve-131"></a>

### Recipient eligibility and evidence recovery (VE-125–VE-131)

125. <a id="ve-125"></a> The common DID schema has no role member. Fresh pairwise allocation
     avoids reuse locally; authentication and relationship formation remain
     identical for every address.
126. <a id="ve-126"></a> A new message ID from a superseded peer node is terminal at receipt before
     message.in, with mediated pickup ACK and no ultimate ACK/effect. A recorded
     observation with the same message ID in R follows the normal integrity rules and
     creates no new response obligation. Later transitions and import order
     do not invalidate previously committed observations or their unfinished
     work, and a shared DID still current in another R remains eligible there.
127. <a id="ve-127"></a> New inbound resolution, binding and receipt use separate dependent
     commits. The receipt references the returned binding eventId; no draft may
     supply a pre-minted eventId. Crash after binding consumes no invitation and
     creates no receipt ACK; recovery reuses that binding after authentication.
     The enclosing receive operation holds the same vault-wide operation lock as
     outbound preparation, so that preparation cannot insert another binding
     between lookup and receipt. Whichever operation binds first supplies the
     reused pin, even when concurrent did:web resolutions return different
     document revisions. Resolver calls and network ACKs occur outside the lock.
128. <a id="ve-128"></a> Confirmation at a shared public root in R_AB does not permit short-form
     root sending in R_BC before its own confirmation. Verify a long-form
     iss/kid against a predecessor with short-form presentedDid using only
     validated DID equivalence and the same authorized method. A changed
     fragment, unrelated DID, invalid long form or newer document's key fails;
     retained bytes and CID stay unchanged.
129. <a id="ve-129"></a> A committed unknown-iss carrier with sub equal to its authenticated sender
     leaves its exact local/sender pair pending. Later proof-free input creates
     no binding, message.in or pickup ACK before predecessor recovery and edge
     verification. Restart and body erasure retain the claim; unrelated local
     pairs remain eligible, and restored incompatible evidence conflicts.
     Time spent awaiting relationship evidence does not consume a resolver
     budget or permit terminal ACK by timeout. While local wait state is
     retained, repeated delivery and reconnect do not resolve again. If that
     state was lost, redelivery re-enters authentication and, when the sender
     method requires resolution, starts one fresh bounded sequence whether or
     not resolution accounting survived; successful authentication rediscovers
     any still-pending pair and returns to the wait. A relevant evidence-change
     retry also gets one fresh bounded sequence when resolution is required,
     under [relationships.md section 10.1](relationships.md#shared-accounting-and-lost-wait-state) and its conformance case
     61. Mediator expiry removes only that delivery; a later delivery cannot
     bypass the retained pending claim.
130. <a id="ve-130"></a> Given the same validated numalgo-4 long form L and short form S, every
     stored resolution document uses id=L, preserves input alsoKnownAs entries
     before appending S, fills omitted method controllers with L and leaves
     relative references unchanged. Embedded methods, explicit external
     controllers, array order and input contexts are preserved as in [section 4.4](#peer-resolved). No resolver-added context or absolute-reference variant is stored.
     Long/short receipt, restore and repeated proof processing reproduce one
     RFC 8785 byte string and raw CID, without a spurious document conflict.
131. <a id="ve-131"></a> For did:web and supported methods with no canonical form, did equals
     the exact valid presentedDid. Host case, percent-encoding or trailing-dot
     differences do not collapse R, pair lookup or predecessor comparison;
     did:web resolution rejects any document id not byte-identical to the
     presented DID. Import applies the same rule without rewriting evidence.

<a id="contact-profiles-ve-132-ve-137"></a>

### Contact profiles (VE-132–VE-137)

132. <a id="ve-132"></a> Contact message and profile views follow only relationship.contactAssigned.
     Two Rs sharing a public DID or key may belong to different contacts
     without profile leakage or an attribution conflict merely from that
     shared evidence. An unassigned R contributes no contact name; conflicting
     assignments choose no contact. Rotation preserves each R's assignment,
     profile history and contact tombstone.
133. <a id="ve-133"></a> profile.nameClaimed references an exact committed message.in eventId and its
     validated R. Unknown, missing, mismatching, anonymous or conflicted source
     evidence cannot supply a projected name. A proof carrier can supply one
     only after its required relationship.peerTransitioned commits. An existing
     valid lifted name survives source-body erasure; a new lift cannot read
     erased content or bypass a contact tombstone.
134. <a id="ve-134"></a> profile.shared references an exact message.out eventId in the same R and
     requires committed valid submission for its message ID. Intent, preparation,
     transport uncertainty and ACK alone do not suffice. Duplicate lifts,
     repacks, erasure and later rotations preserve the one source disclosure;
     they cannot mark a different R as shared or reopen submitted work.
135. <a id="ve-135"></a> Profile ordering uses the earliest canonical source event of each logical
     message, not lift-event order. Recovery lifting an old claim after a newer
     message, duplicate observations, cross-key aliases and every import order
     yield the same latest name. Conflicting names lifted from one logical
     source remain a profile conflict and supply no name from that source;
     other valid claims remain usable under the same ordering.
136. <a id="ve-136"></a> The per-R profile result includes claimedName, nameConflict and shared.
     With no lifts it is null, false and null. Conflicting names from
     one otherwise valid logical source set nameConflict without hiding an
     older non-conflicted name. Shared selects the latest logical disclosure
     using each source's minimum (at, eventId, author), never submission or lift
     order. Contact profileShared lists only uniquely assigned non-conflicted
     Rs with non-null shared and their source keys, sorted by R. Two Rs at one
     contact stay separate, and an unassigned or conflicted R contributes none.
     Duplicate lifts, rotation, body erasure and shuffled event arrival leave
     the projection unchanged; no sharing projection authorizes another send.
137. <a id="ve-137"></a> A crash after a readable profile source commits but before its lift leaves
     work that is recoverable on reopen; outbound sharing also requires its
     valid committed submission. Later scope/evidence recovery permits the same
     idempotent lift without mediator redelivery or a local queue. Existing lifts
     are reused; submitted outbounds never prepare or send again. If erasure or a
     contact tombstone wins before lifting, recovery creates no new lift, even if
     bytes remain under another root. Retained skeletons preserve an existing
     valid sharing lift but msgType alone cannot create one after content erasure.

<a id="complete-witnesses-and-receipt-timing-ve-138-ve-139"></a>

### Complete witnesses and receipt timing (VE-138–VE-139)

138. <a id="ve-138"></a> ACK and peer-transition claims use complete observation witnesses under
     [section 10.5](#complete-observation-witnesses). If different candidates each match only part of a claim's
     required fields or evidence, they cannot jointly witness it. Adding one
     complete matching duplicate permits the claim once its other gates pass,
     even when another duplicate event is absent. An exact resolution reference
     cannot be replaced merely because another event has the same key or
     document. Matching never clears a group conflict or bypasses a required
     missing-evidence deferral; enumeration and import order select no winner.
139. <a id="ve-139"></a> ACK receipt considers every valid complete carrier across duplicates and
     distinct ACK-bearing message IDs in the same R. Selecting a later witness
     for delivery.acknowledged cannot hide an earlier on-time receipt or change
     late; an ineligible earlier observation cannot donate its timestamp.
     Shuffled enumeration and event import produce the same receiptInstant and
     late, independently of which eligible witness was used for lifting.
