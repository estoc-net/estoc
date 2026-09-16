# The Estoc vault events, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — event vocabulary and fold rules for
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
[channels.md](channels.md) owns channel identity, channel acceptance and
operation eligibility; receipt precedes local acceptance and continuity work.

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
| Channels and continuity | [Acceptance and directed links](#relationships-and-address-changes) | [Channel and continuity projections](#relationship-fold-and-address-index) | [Channel and display policy](relationships.md#symmetric-relationship-identity); [Early privacy policy](relationships.md#early-private-address-policy-and-notifications); [Rotate local address](#rotate-a-local-relationship-address) |
| Contacts and profiles | [Contact events](#contacts); [Channel selections](#contact-channelsset); [Name claims](#profile-nameclaimed); [Sharing observations](#profile-shared) | [Channel profiles](#relationship-profile-fold); [Contacts](#contact-fold) | [Delete contact](#delete-a-contact) |
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
- [6. Channels, continuity and contact membership](#relationships-and-address-changes)
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
- **materialization** — selected work made durable, such as the exact
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
   registration, receive and expose pending delivery for explicit manual action.
5. **Stable IDs identify exact manual retries.** A logical message, an encrypted package
   and a mediator delivery have different IDs and different lifetimes.
6. **Duplicate work is expected.** Manual retry and mailbox redelivery may repeat work; recovery grants
   no automatic dispatch action. Folds and handlers
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
and pairwise communication DIDs. Disclosing a rendezvous DID or running
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
`did:peer:4` entity. A local `did.rotationSelected` under
[section 6.5](#relationship-localtransitioned) authorizes a successor channel
for new intents; existing intents retain their channel. Rendezvous replacement
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
| Typed event reference | `EventReference<T>` | payload fields ending in `EventId` and elements of `*EventIds`, including source, trigger, resolution, acceptance, rotation and attempt references |
| Contact | `ContactId` | `contactId`, `fromContactId` |
| Local/peer DID pair | `Channel` | `channels` entries; `localDid` and `peerDid` in selectors |
| Local DID entity | `DidId` | `didId`, `localDidId`, `senderDidId`, `fromDidId`, `toDidId` |
| Route / mediation arrangement | `RouteId` / `MediationId` | `routeId`, `boundRouteId` / `mediationId` |
| One prepared package | `PackageId` | `packageId`, `replacementPackageId` |
| Scoped mediator delivery | `DeliveryId` | `deliveryId` |
| Sender/recipient-scoped automatic execution | `ExecutionId` | `executionId` |
| Exact content bytes | `Cid` | `bodyCid`, `attachmentCids`, `documentCid`, `envelopeCid`, `dropCids`; generic object APIs use `cid` |
| Vault keystore name | `KeyName` | `localKeyName`, `me.keyName` |
| Complete canonical public-key value | `PublicKey` | `peerPublicKey` |
| DID string / verification-method DID URL | `Did` / `DidUrl` | `did`, `localDid`, `peerDid`, `recipientDid`, `presentedDid`, `longFormDid`, `fromDid`, `toDid` / `authenticationMethodIds`, `keyAgreementMethodIds` |

For every payload `*EventId`, `T` is the target event type fixed by the
referencing schema. `sourceEventId` is `EventReference<"message.in">` in
`profile.nameClaimed`, `channel.accepted`, `message.fromPriorResolved`,
`did.rotationSelected` and `message.out`, and
`EventReference<"message.out">` in `profile.shared`;
`channelAcceptanceEventId` in `profile.nameClaimed` names `channel.accepted`;
`fromDidId` and `toDidId` in `did.rotationSelected` name local DID entities;
`rotationEventId` in
`message.out` names `did.rotationSelected`.
`triggerEventId` is `EventReference<"message.in">`, and `addEventId` is
`EventReference<"contact.peerDidAdded">`. The referencing schema also owns
presence and nullability; a nullable reference has the same typed non-null
value. Generic event-store APIs continue to use `EventId`.

Use the same entity noun for creation and later references: `did.created.didId`
and `did.disclosed.didId`, for example. Add a role prefix when needed, such as
`senderDidId`. Payloads do not abbreviate a contact ID as `cid`, or hide an
entity ID behind a bare `id`, `contact` or `mediation` field.
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
type Channel = { localDid: Did; peerDid: Did };
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

Identifiers serialize as validated strings without wrapper objects or type
prefixes. `Channel` serializes as a record of two canonical DID strings. Parsers
and derivation functions produce them only after the owning format checks.
A cast is not validation. An event-reference
type records its required target type; missing evidence still defers and
incompatible evidence still conflicts under the referencing schema. It is
never proof that the target is available or valid. `effectKey` is the existing
derived idempotency key, not a keystore name or a cryptographic public key.

Message identity has three levels. `eventId` names one exact receipt or other
event; repeated receipt may create several event IDs with one `messageId`.
An inbound `messageId` names the exact sender/recipient/wire-ID input; accepted
key variants in that channel share one execution. Different channels never
alias message or execution identities.
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
an arbitrary renamed payload or API object as its substitute. The sender-and-recipient execution transcript is specified in
[distributed-delivery.md](distributed-delivery.md#execution-id-and-immutable-transcript);
contact IDs are never part of it. Event
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
provide authentication, decryption and package evidence; they do not assign a
contact. Anonymous input and mediator traffic may retain key
evidence without an application channel.

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
an outbound package it is the selected recipient key. A peer resolution records
the key-agreement key used for receipt/preparation. Predecessor JWT checks use
the document associated by `message.fromPriorResolved` and its authentication
methods directly. Selection alone is not evidence
of authenticated inbound traffic or remote receipt.

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
always means this derived value. `peer.resolved` and ACK observations retain
their explicit keys. Continuity links derive from exact proof evidence and local decisions.
Profile observations instead
reference their source message under [sections 7.3](#profile-nameclaimed)–[7.4](#profile-shared).

`message.in.presentedDid` preserves the wire spelling, and
`peer.resolved.presentedDid` preserves the spelling used for resolution.
First-disclosure validation and recovery use this retained evidence. The
accepted-pair projection serves consumers requiring channel acceptance under
[section 6.6](#relationship-fold-and-address-index);
a verified link may justify a new channel without changing earlier message IDs.
Equal key values under different DIDs do not supply channel authority or a
contact assignment. An observation awaiting acceptance for one consumer keeps
its key evidence; other consumers check their own prerequisites independently.

<a id="mediation-key-evidence"></a>

### 4.2 Mediation key evidence

Traffic between the vault and a mediator uses a local key beginning with:

```text
mediation/
```

These observations belong to the mediation fold, not application
channels or contact/profile projections.

<a id="11-peer-and-profile-observations"></a>

<a id="peer-and-profile-observations"></a>

<a id="43-peer-and-profile-observations"></a>

<a id="resolution-observations"></a>

### 4.3 Resolution observations

Resolution observations retain exact cryptographic evidence. Peer continuity
links follow the same rule in [section 6.4](#relationship-peertransitioned);
profile observations name one channel and their source message in
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
peer key. `localKeyName` identifies the local communication key/context.

- `presentedDid` is the exact DID string supplied for resolution, preserved
  across any resolver-internal URL or DNS normalization.
- `did` is the canonical DID used by folds under [relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile),
  including its exact-string rule for `did:web`. For Peer DID numalgo 4 it is
  the short form; first disclosure keeps the long form in `presentedDid`.
- `documentCid` names the raw DASL object containing exact RFC 8785 canonical
  resolved DID document JSON. Its CID commits to those bytes.
- the selected or authenticated `peerPublicKey` must be present under the named DID and exact
  document;
- `authenticationMethodIds` and `keyAgreementMethodIds` enumerate all methods authorized
  for those purposes in the exact retained document, with references resolved
  against that document's `id`. They do not prove every listed key controlled the
  observed message. Each consuming message or acceptance references its
  own exact evidence; method lists from different revisions MUST NOT be unioned
  into a channel-wide authorization set; and
- `service` is the selected DIDComm service URI or null.

`channel.accepted` references the evidence of its initial decision. Later
receipts and packages may reference other method-authorized revisions under
the same canonical DID without another acceptance. Predecessor JWT documents
are associated separately through `message.fromPriorResolved`; the receipt's
`peerResolutionEventId` continues to authenticate the current sender only.
Both use the canonical document representation below. Those exact objects
remain historical evidence; a later revision cannot replace any reference.
If the event or object is temporarily missing, processing is deferred until
verified recovery material is available; absence is not proof that the
transition is invalid. Phase 1 does not depend on deferred vault sync.

For a `did:peer:4` first disclosure, the implementation decodes and validates
`presentedDid`, derives `did` and the document locally, and stores both forms.
A short form received before corresponding long-form resolution evidence is
known cannot establish authenticated channel receipt.

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
validates this representation against `L`; it never repairs evidence by rewriting
the retained bytes or CID. Method-ID comparison follows [section 6.4](#relationship-peertransitioned).

Equivalent duplicate observations are harmless. Different valid Web document
revisions for the same DID may coexist and need no portable ordering. Same
document CID with incompatible contents is an integrity conflict; a different
document under one immutable Peer DID is invalid method evidence.

<a id="mediation-communication-dids-and-routes"></a>

## 5. Mediation, communication DIDs and routes

Mediation arrangements, communication DIDs and their private keys belong to
the vault. Their meaning never depends on the event author or the process
executing the full runtime. DID-document publication is outside vault state.

All communication DIDs have the same send, receive, acceptance and continuity
semantics. The core stores no public/pairwise role. Disclosure records and
local address-allocation policy describe whether an address is public or was
created for private use with one peer. Routes are reusable vault-scoped
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
old and new DIDs and routes to overlap during cutover. Each affected channel
context uses its own [section-6.5](#relationship-localtransitioned) local decision
for new intents; mediation selection
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
    "admitChannel": true,
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb",
    "goal": "Write to Alice"
  }
}
```

`as` is `oob`, `profile` or `direct`; `uses` is `one` or `many`. `oobId`
is REQUIRED when `as == "oob"` and null otherwise. `goal` is nullable.
`admitChannel` is a REQUIRED boolean. It records the local user's
permission for matching OOB input to accept its channel without a
second user decision. It MUST be false for `profile` or `direct` disclosure;
creating an OOB invitation requires an explicit choice of this permission.
False leaves channel acceptance awaiting a manual decision; it does not gate
operations whose own evidence and policy permit work without acceptance.
True changes neither cryptographic checks nor single-use, tombstone or
continuity rules.
`data.didId` references the local entity's `did.created.data.didId` under
[section 3.5](#identifier-and-reference-vocabulary). Its DID spellings remain on that entity.
A one-use OOB invitation may disclose any live communication DID; matching
proof-free `channel.accepted` consumes it under [section 5.8](#invitation-fold).

This is the permanent record that an address was revealed. Before disclosure,
a mediated `boundRouteId` MUST have currently verified recipient registration.
Reusable/public disclosure SHOULD use an address allocated for discovery, and
SHOULD NOT publish an address already allocated for private communication.
These are privacy policies, not channel-acceptance or cryptographic role
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

Retirement is terminal for new sending, disclosure and channel acceptance
using this DID. Its mediated recipient registration leaves the desired set.
It does not erase keys, documents, channel acceptances, received messages or continuity evidence.

A retained exact local key remains eligible for authenticated channel
receipt while its bound route has no terminal dependency, including after DID
retirement. This rule applies equally to publicly disclosed and privately
allocated addresses. No renewed registration is required to drain retained
deliveries. An unknown address pair cannot acquire channel acceptance on a
retired local DID. [relationships.md section 9](relationships.md#uniform-receipt) owns the receipt gates;
[distributed-delivery.md section 4.3](distributed-delivery.md#receive-a-message) owns the receive procedure.

Retain key/document evidence and usable mediation needed by retained channels.
Channel denials and sender/route eligibility govern new work. Retained
confirmation may justify an explicitly requested recovery rotation without reviving
the old route. Retirement never erases committed message or attempt evidence;
display contact deletion alone is not a transport or authorization operation.

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
or referenced by a configured, non-retired, conflict-free route bound by a
retained local DID, including a retired DID. Its exact key/document evidence
must be consistent; recoverable missing material leaves that dependency pending
instead of removing it. Allocation/disclosure
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

The complete acceptance/consumption rule is owned by
[channels.md](channels.md#admission). A live one-use OOB disclosure is available
until a complete matching proof-free `channel.accepted` consumes it. The consumer
is the canonical peer DID within that disclosure's fixed local DID. Receipt,
contact membership, output intents and local rotation alone do not consume
the invitation. `admitChannel` permits automatic invitation acceptance; false
still allows an explicit manual acceptance decision. This flag controls
acceptance, not the independent policy for automatic output or rotation.

Missing acceptance/source/disclosure evidence that could establish consumption
leaves availability pending. Commit a consumer only after locked availability
recheck. Reuse by the same canonical peer under that disclosure is idempotent;
incompatible imported consumers are an unavailable conflict, with no event-order
winner. Later erasure, denial,
retirement or conflict never reopens a structurally valid consumption. Validate
positive evidence before availability to avoid a circular fold.

<a id="12-relationships-and-address-changes"></a>
<a id="relationships-and-address-changes"></a>

## 6. Channels, continuity and contact membership

Channel identity, acceptance, continuity links, local denial and contact views
are defined in [channels.md](channels.md).

<a id="121-receipt-and-relationship-evidence"></a>
<a id="receipt-and-relationship-evidence"></a>

### 6.1 Receipt and channel evidence

Channel receipt commits independently. Under one vault operation lock,
acceptance operations recheck exact DID pairs and evidence, local lifecycle,
denial, invitation availability and equivalent committed evidence. Every event reference must
name an already committed event; use returned IDs, not an assumed same-batch
ID. Release the vault lock before network calls. Per-message dispatch is
separately serialized under [delivery](distributed-delivery.md#send-an-ordinary-message).

<a id="122-relationshipbound"></a>
<a id="relationship-bound"></a>

### 6.2 `channel.accepted`

The closed schema and all local admission bases are in
[channels.md](channels.md#channel-accepted). Each receipt keeps its actual channel.
Known missing references defer acceptance; they never block independent receipt.

<a id="123-relationshipcontactassigned"></a>
<a id="relationship-contactassigned"></a>
<a id="contact-channelsset"></a>

### 6.3 `contact.channelsSet`

```json
{
  "type": "contact.channelsSet",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "channels": [
      {
        "localDid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
        "peerDid": "did:web:bob.example"
      }
    ]
  }
}
```

The closed data contains exactly `contactId` (UUIDv7) and `channels`, an array
of closed `{localDid, peerDid}` selectors under [channel identity](channels.md#channel-identity);
`roots` is empty. The list is duplicate-free and sorted by the canonical pair
encoding specified there. Latest canonical event per contact replaces its entire
selected set; an empty list clears it. Concurrent sets are not unioned. No set
event means an empty selection. This event neither creates a contact nor
restores a deleted contact; missing contact data affects only presentation.

Selection requires no channel acceptance. Missing channel evidence leaves an
unresolved display selection; the selected strings alone authorize no sending.
One channel MAY be selected by several contacts; this creates overlapping
views, not an identity conflict or a canonical contact for that channel.
Changing one contact's set does not change another's. No ownership, permission,
authentication evidence or execution identity transfers through membership.
Derived related history follows [the channel view rules](channels.md#contact-channels)
without rewriting this exact set. Membership may be edited offline.

<a id="112-relationshippeertransitioned"></a>
<a id="relationship-peertransitioned"></a>

### 6.4 Peer proof evidence and continuity

Use `message.fromPriorResolved` under
[channels.md](channels.md#message-frompriorresolved) to associate an exact
committed carrier with its issuer document CID. The event's own root retains
that document independently of message-content erasure. It stores no link,
acceptance decision or trusted verification result. The carrier needs no
handler execution or known predecessor channel to save proof evidence.

The proof's `iss` canonicalizes to the associated document's DID and, for
channel inheritance, the predecessor channel's peer DID; `sub` equals
the carrier's exact plaintext `from` and authcrypt sender spelling and
canonicalizes to the successor DID. The two canonical DIDs must differ.
`iat` is an integer Epoch-Seconds value: it has no message-age acceptance window
and elects neither a branch nor a document snapshot. The protected JWT `kid`
has a DID portion byte-identical to `iss` and names an authentication method
authorized by the exact predecessor document. Use maintained signature and
encoding APIs to verify the original JWT; decoding alone proves nothing.

For predecessor comparison, validate any Peer long form and derive its short
form under [the DID profile](relationships.md#peer-did-numalgo-4-profile).
Other supported methods use that profile's canonicalization, including its
exact-string fallback. The stored document's DID spelling need not equal
`iss` if these validated canonical forms agree. To compare `kid` with that document's
authentication methods, resolve relative method references against its `id`,
then canonicalize only the DID portions of the two DID URLs. All remaining
components, including the fragment, match byte-for-byte. This comparison
rewrites neither the JWT signing input nor the retained document or CID.

New proof evidence follows [predecessor resolution](relationships.md#predecessor-resolution).
Recovery of a saved association uses only its exact referenced document; network
retrieval can fill missing bytes only when their canonical CID matches.
Missing material defers verification; an invalid signature, claim, method or
long form grants no proof authority. Repeated evidence for the same predecessor and
successor is the same DID replacement even when method-authorized predecessor
or successor document revisions differ. Verify each complete witness's own
references; different revisions alone are not conflicting successors. Shared
keys, current resolution alone and display assignment cannot replace the
channel context and verified proof.

<a id="124-relationshiplocaltransitioned"></a>
<a id="relationship-localtransitioned"></a>

### 6.5 Local continuity decisions

Use `did.rotationSelected` under
[channels.md](channels.md#did-rotationselected). Freeze successor, route, proof and any
trigger before disclosure. The decision fixes its predecessor through
`fromDidId` and canonical `peerDid`, including for a source-free manual rotation.
Confirmation uses a complete source witness with the exact address and
peer/context evidence, independently of channel acceptance and without depending
on the rotation being selected.
Rotation changes only newly created outbound intents. Existing queued/prepared
messages keep their channel, even before any attempt. No package is retired or
repacked merely to follow a successor. Explicit lifecycle/security denial may
block a retry without relocating it.

<a id="144-relationship-fold-and-address-index"></a>
<a id="relationship-fold-and-address-index"></a>

### 6.6 Channel and continuity projections

Index exact ordered pairs by their canonical local and peer DID strings.
Derive accepted pairs, directed links, verified opposite-side joins, local-only supersession contexts and
denials under [channels.md](channels.md#continuity). Edges and verification
statuses are derived; each edge exposes its complete source witnesses.
Missing references defer the affected projection; contradictory identities,
proofs or same-end successors conflict. Message and execution identities remain
fixed when graph history changes.

Contact membership is a separate projection and is never read as a
cryptographic prerequisite. A contact can show multiple disconnected channel chains.

<a id="7-contacts"></a>

<a id="contacts"></a>

## 7. Contacts and profiles

A contact is a set of decisions identified by one `contactId`. It may hold an
unverified discovery DID before a channel is accepted, and selects channels
directly under [section 6.3](#contact-channelsset), independently of their
authority and continuity. There is no intermediate display-group entity.
Contact IDs name local decisions; they do not merge protocol identities.

<a id="contact-ids"></a>

### 7.1 Contact IDs

See [relationships.md section 5.1](relationships.md#contact-ids).

<a id="contact-event-schemas"></a>

### 7.2 Contact event schemas

Direct channel selections use `contact.channelsSet` in
[section 6.3](#contact-channelsset).

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
    "because": "channel"
  }
}
```

This outbound preference associates one of our communication DID entities
with the contact. `data.didId` is that entity's `did.created.data.didId` under
[section 3.5](#identifier-and-reference-vocabulary). `because` is `channel`, `rendezvous`,
`manual` or another documented policy value.

This preference selects among eligible channels for a new send under
[sections 9.2](#message-out) and [7.6](#contact-fold). It cannot change an existing
intent's endpoints, roll back continuity or grant permission through a contact. A publicly disclosed local address may
send normally; fresh private allocation is the default policy in
[relationships.md section 11](relationships.md#early-private-address-policy-and-notifications).
`contact.channelsSet` selects the displayed channels independently of these
address preferences.

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
of channel acceptance. `because` is `oob`, `user`, `rendezvous`,
`resolved` or another documented source.

The event is a routing/contact decision, not proof that the peer controls the
DID. `peer.resolved` or a verified received proof supplies
cryptographic evidence later; display assignment supplies none.

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
those contact views, but every member retains its own contact ID, decisions
and selected channel set. This event MUST NOT affect attribution, DID selection,
continuity, message or execution identity, ACK scope, channel receipt, invitation
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
    "sourceEventId": "019b2a84-44ef-7d16-8d04-2b9a5c2a06b1",
    "channelAcceptanceEventId": "019b4d11-22d3-7fd0-82fb-f33864a75dd5",
    "name": "Alice L."
  }
}
```

The closed data has exactly `sourceEventId`,
`channelAcceptanceEventId` and `name`; roots are empty. The source is one exact
already committed `message.in` forming a complete channel witness with the
referenced acceptance under [operation eligibility](channels.md#operation-eligibility).
Derive the channel from that source and verify it matches the acceptance.
A supported profile protocol must
define its own fields and extraction; arbitrary Basic Message text is not a
profile. Under the operation lock, lift only from readable, non-erased eligible
content whose channel is not denied or superseded and whose current profile
policy permits the lift. Existing lifted values survive ordinary policy changes and body
erasure, hold no roots and remain
peer claims rather than verified human names. Missing references defer them;
incompatible evidence conflicts. Later contact edits cannot move their source.

<a id="114-profileshared"></a>
<a id="profile-shared"></a>

### 7.4 `profile.shared`

```json
{
  "type": "profile.shared",
  "roots": [],
  "data": {
    "sourceEventId": "019b2a85-0912-7b2c-9425-4fd7fd0dd019"
  }
}
```

The closed data has exactly `sourceEventId`; roots are empty. The source is one
exact `message.out`; its fixed sender and recipient determine the channel. Lift a
supported profile disclosure from readable content only after a valid committed submission
with its attempt/package evidence. An intent, attempt or peer ACK alone is
insufficient. Existing lifts can validate their source linkage after erasure;
they do not reconstruct missing content. Recovery of this local projection
never prepares or dispatches a message.

<a id="145-relationship-profile-fold"></a>
<a id="relationship-profile-fold"></a>

### 7.5 Channel profile fold

Group profile facts by exact source channel. Deduplicate each type by logical
source message; equal names count once and different names for one source
conflict. Order sources by their minimum complete canonical source-event key
`(at, eventId, author)`, never lift time. Keep `claimedName`, `nameConflict` and
latest `shared` source key per channel; missing evidence contributes diagnostics.

Contact views may aggregate these channel-labelled facts. They do not transfer
a profile-sharing decision or cryptographic trust to another channel. A missing
readable eligible profile lift may be rebuilt locally; this creates no network
dispatch permission and grants no ACK or continuity authority.

<a id="146-contact-fold"></a>
<a id="contact-fold"></a>

### 7.6 Contact fold

Fold contacts independently: permanent deletion tombstone, latest
petname/flags, explicit peer DID seeds minus their referenced removals, and the
latest `contact.channelsSet`. A tombstone hides the contact even if later
membership events exist; its channels remain independently available. Aggregate
source-labelled profile facts and channel-local messages without merging their
identities or counting a message twice within one combined view. Missing or
conflicting authentication evidence remains visible in the source channel.

`writeTo[]` is the concrete eligible channel choices shown for a new user send
from the contact's selected channels and their verified continuations.
Membership is not eligibility: each choice needs its exact pair, usable local
key/route and current send policy. A derived continuation additionally needs
its complete link evidence. A deliberate new peer address, including an
explicit discovery seed, can start a fixed-channel intent without acceptance;
preparation still validates its own peer resolution.
`contact.useDid` only expresses a local-address preference among eligible
options. If it does not resolve to one channel, the caller must select a
concrete eligible channel explicitly; matching contact names, peer DIDs or
contact merges do not choose one. Selection happens before intent commit and
never retargets a saved intent. Contact membership or a new derived successor
does not supply an automatic send action.

A deleted contact is hidden by contact policy. Blocking/cleanup requires the
separate explicit channel decisions in [section 13.6](#delete-a-contact).
Regrouping never modifies those decisions. A supported same-DID key change or
remote Report Problem is shown only with exact channel/message evidence;
names, shared keys and wire-ID matches alone do not attribute it. A remote
error changes neither submission state nor dispatch authority.

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

The resulting `messageId` is also the response's wire ID. Manual retry preserves this ID and its fixed channel. Pre-attempt preparation
also preserves it. Equivalent automatic effects therefore identify one
logical response.

<a id="message-out"></a>

### 9.2 `message.out`

```json
{
  "type": "message.out",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "senderDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "recipientDid": "did:web:bob.example",
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
    "effectType": null,
    "effectKey": null,
    "sourceEventId": null,
    "rotationEventId": null
  }
}
```

`senderDidId` and `recipientDid` are REQUIRED and immutable.
The sender names an existing eligible local DID; the recipient retains the selected
peer DID spelling. Their canonical local/peer pair fixes the channel and direction.
Select these addresses under the operation lock before intent commit. Every
package must match them. Rotation changes selection for new
intents only; even a never-attempted intent is not retargeted. See
[fixed outbound channels](channels.md#fixed-outbound-channel).

The selected `recipientDid` retains the exact supplied spelling, including a
validated Peer long form needed for offline first preparation. Canonicalize it
for channel identity and package endpoint comparison. No resolver lookup is
required to record this selection. Preparation retains its own exact peer
evidence and validates the fixed-channel intent without requiring
`channel.accepted`. An automatic intent requires its complete source witness,
the permitted response path and operation-specific policy under
[operation eligibility](channels.md#operation-eligibility).

The UI may select a channel through a contact, but the contact ID is not stored
as protocol identity. The two fixed address fields are portable intent
metadata, excluded from the DIDComm intent
hash but included in full event equality. They cannot be changed by rotation,
manual retry, contact regrouping or a different replica.

For automatic output, choose one channel authorized for replying to the exact
source witness. A verified role-preserving successor path may permit a new
response on a successor channel. Once that response intent exists, its channel
is fixed; source duplicates cannot select another channel for the same effect.

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
- `executionId`, `effectType` and `effectKey` are all
  null for a locally initiated send and all non-null for an inbound-derived
  protocol effect, including an explicitly requested completion of pending
  response work. A local user or policy decision may initiate an ordinary
  message without a carrier at a fixed channel; explicit user selection may
  choose a new channel. It commits intent before network effects;
- `sourceEventId` is required and non-null for an inbound-derived effect,
  otherwise null. It names one exact already committed `message.in` forming a
  complete source witness. Its logical input derives `executionId`; its actual
  channel is the output channel or a verified role-preserving predecessor.
  Authentication and required proof evidence must be complete independently
  of the intent. No channel acceptance reference or accepted-pair lookup is
  required to create or validate the output;
- `rotationEventId` is required and non-null exactly for a dedicated rotation
  notification. It names an already committed `did.rotationSelected`; sender,
  recipient and notification fields obey [the built-in operation rules](distributed-delivery.md#built-in-independent-operations).
  If that decision has a trigger, the intent's `sourceEventId` equals the
  decision's `sourceEventId`, whose channel matches its `fromDidId`/`peerDid`,
  and its effect tuple uses that source. Without a trigger, the source reference
  and all three effect fields are null; the locally initiated intent still
  names the rotation.
  An ordinary message carrying the selected proof is not a notification and
  keeps `rotationEventId == null`;
- a locally initiated send has `ack == []`; honoring an inbound ACK request uses
  the deterministic response algorithm;
- `effectType` is the protocol-defined operation URI under
  [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects);
  distinct operations may share a DIDComm `msgType` but have distinct effect types;
- an automatic intent stores the complete `(executionId, effectType)` tuple. Validation checks
  its execution ID against the carrier group, its tuple and intent against the
  producing protocol, recomputes its key under [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects), and requires its `messageId` to equal the [section-9.1](#ids) derivation;
- the three automatic-effect fields and two source/rotation references are portable metadata excluded from
  the wire and intent hash; they still participate in full event equality;
- `thid`, `pthid`, `expiresTime` and all three automatic-effect
  fields are present with null when unused; and
- appending this event requires no network, resolver, mediator or socket.

A preparer emits `created_time`, `expires_time`, `thid` and `pthid` only when
non-null; emits `please_ack` whenever `pleaseAck` is non-null; emits `ack` and
`attachments` when non-empty; and expands `headers` at plaintext top level.

Import validates the exact saved source, fixed endpoints and required proof evidence.
It does not rerun old local policy to erase a previously committed intent;
current policy still gates any new dispatch. A duplicate trigger reuses the
existing intent without replacing its source references with another observation.

More than one `message.out` under one `messageId` is allowed only when every field
is identical. Different channel, sender or recipient values conflict even when
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

This event makes one exact normalized encrypted envelope recoverable as data.
Importing it grants no dispatch permission to another runtime.

Requirements:

- `senderDidId` equals the fixed sender in `message.out`; retained key/route
  eligibility is checked without replacing it with a later current address;
- the package matches the exact oriented channel in a valid `message.out` and
  has complete local-key and peer-resolution evidence; channel acceptance is
  not required;
- `localKeyName` is that entity's key-agreement key and authorizes the plaintext
  `from` under the exact spelling used by the package;
- the plaintext `id` equals `message.out.messageId`; its other semantic fields
  and immutable control headers equal the committed intent;
- `intentHash` equals the intent value;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- the canonical sender and recipient must equal the intent's fixed endpoints
  in the same roles under [channel identity](channels.md#channel-identity);
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

All packages for one `messageId` preserve its intent hash, oriented channel
and immutable headers. Before any attempt, an original live send may prepare
another package only within this fixed channel using eligible retained
authentication evidence. It cannot select another DID at either end. Once any
`delivery.attempted` exists, its exact package is frozen for every retry; no
replacement encryption, key selection, proof or spelling change is permitted.
Incomplete attempt/package references block new preparation. After submission
or message-terminal failure, no preparation or retry is permitted.

Lifecycle and security eligibility are checked again at dispatch. A failed check
never moves this message to a successor. Historical package evidence remains
valid when later policy prevents another submission.

The package names no recipient replica. Rendezvous and pairwise
channel messages follow the same package rules.

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

`replacementPackageId` is nullable. Retirement permanently stops submission
of this package, including manual retry. A replacement is permitted only
before any attempt and within the same fixed channel. An attempted package
cannot be replaced; retiring it leaves the original outcome intact and any
further send requires a new message. Retirement does not itself terminate
the logical message. Its envelope contribution is determined only by
[section 12.3](#held-roots)'s retention predicate. Historical submission and
channel evidence remain valid; retirement cannot undo a completed submission.

<a id="delivery-attempted"></a>

### 9.4.1 `delivery.attempted`

```json
{
  "type": "delivery.attempted",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "trigger": "initial"
  }
}
```

The closed payload has exactly these three fields. `trigger` is `initial` or
`manual`. The exact intent and package must already be committed and valid.
All attempts for this message name the same package. `initial` is permitted
only by the live local action that created the intent, before any attempt;
`manual` records a fresh explicit retry action. Event import is not that action.
The trigger records local provenance, not remote proof of a user's identity.

Commit this event under the message's serialized dispatch operation, rechecking
eligibility under the vault operation lock. Release the vault lock before the
network call. Only the still-live invocation receiving its returned event ID
may use that event for one call. Scanning/replaying an event never supplies this
local dispatch authority. A crash immediately after commit consumes that live
invocation even if no packet left the process. Every further call needs a new
manual event. An uncertain append authorizes no transport call.

This is portable evidence that submission may have been attempted, not a
submission success. Missing package/intent references make it incomplete and
block sending; conflicting packages for one message expose a conflict without
selecting the earliest event. It has no independent held roots.

<a id="delivery-submitted"></a>

### 9.5 `delivery.submitted`

```json
{
  "type": "delivery.submitted",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "attemptEventId": "019b2a74-148d-7d68-9eb2-f4e135817924"
  }
}
```

This says only that one transport endpoint accepted the attempt. It does not
mean route existence, mediator retention, pickup or ultimate durable receipt.

`packageId` MUST identify a valid `message.prepared` for this exact `messageId`.
A local runtime appends this event after observing transport acceptance. Its
successful commit completes submission for the entire logical outbound under
[section 9.8](#outbound-message-and-delivery-fold). `attemptEventId` is required
and names the already committed `delivery.attempted` for this message/package.
If acceptance happened but this observation did not commit, the outcome remains
unconfirmed and requires explicit manual retry; recovery never resubmits it.

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

- package scope makes that package terminal. Another package for the same
  message is permitted only before any attempt and in the same fixed channel.
  A terminal attempted package cannot be replaced or retried; further sending
  requires a new message ID.
- message scope stops all preparation and submission for the intent, including
  manual retry.
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

The exact carrier is a complete channel witness under
[operation eligibility](channels.md#operation-eligibility). Its explicit `ack`
names this outbound wire ID. Its channel must be the
outbound's fixed channel or a verified role-preserving successor under
[channels.md](channels.md#continuity). Validate the outbound intent and exact
prepared package independently; display membership never supplies that path.
All redundant local-key, sender, wire-ID and message fields match this one
complete witness. Do not assemble a witness from incomplete sibling rows.

This records peer receipt information only. It cannot synthesize submission,
release a package envelope or authorize a retry. Missing references defer;
incompatible evidence conflicts. All five data fields are required:
`messageId` names the outbound; `ackMessageId` and `ackWireMessageId` name
the carrier's vault and wire IDs; `localKeyName` and `peerPublicKey` equal
that complete carrier's local key and derived authenticated peer key.

<a id="148-outbound-message-and-delivery-fold"></a>
<a id="outbound-message-and-delivery-fold"></a>

### 9.8 Outbound message and delivery fold

For each message ID, require one consistent complete `message.out` intent.
All prepared packages preserve its fixed oriented channel and intent hash.
Before any attempt, eligible initial/manual preparation may replace a package
within that channel. After an attempt, every attempt must name the same exact
package. A missing referenced package/intent blocks preparation and dispatch;
incompatible attempted packages conflict without choosing the first by time.

Derive these independent facts:

- `packages[]`: valid exact packages, including retained retired skeletons;
- `attempted`: valid `delivery.attempted` evidence exists; this means a call may
  have happened even when the producer crashed before invoking transport;
- `submitted`: a complete valid `delivery.submitted` names the exact matching
  attempt, intent and package. Later erasure, retirement or policy cannot remove
  this historical fact. An incomplete unrelated row cannot erase it;
- `ackWitnesses`: all complete channel witnesses satisfying section 9.7;
- `acknowledged`: at least one such witness exists; and
- terminal package/message failures and permanent erasures under their schemas.

For an inbound-derived output, verify its `(executionId, effectType)` tuple
against its exact complete source witness in the channel-local
execution and the producing protocol's operation rules. Each tuple permits
at most one compatible intent. ACK, Ping reply and rotation notification have
distinct effect types and coexist for one execution.
A tuple-local output conflict stops that operation; an authenticated
source-intent conflict stops all affected
source-derived work. Notification selection conflicts are scoped to the exact
rotation decision. None of these conflicts reopens recorded submission.

Portable eligibility requires valid evidence, retained bytes, an unexpired,
unsubmitted, nonterminal, nonerased intent and permitted keys/routes/channel
policy. It is necessary but never sufficient for dispatch: only a live initial
or fresh manual action may append an attempt and make its one call. Current
graph tips select new intents, not replacement endpoints for existing ones.
No fold scans `queued` records into network work after open/import/restore.

Displayed outcome precedence is:

```text
conflict
submitted
expired-or-terminal-failure
attempted-unconfirmed
prepared
queued
```

`attempted-unconfirmed` does not claim failure or nondelivery. With an old or
partial snapshot, even `queued`/`prepared` can have unknown external history;
all restored pending records require manual action. UI may separately show
that requirement. A submitted/terminal record cannot retry; a deliberate new
send creates a new ID without altering the old outcome.

Receipt timing uses the earliest parsed RFC 3339 source-observation `at` among
valid ACK witnesses. `late` is true exactly when acknowledged, an immutable
expiry exists, and that instant is at or after expiry. It uses no current
clock or ACK-lift timestamp. Neither ACK timing nor missing ACK changes
submission state, envelope retention or dispatch authority.

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
    "messageId": "336032bf-0c6e-5ce7-a3ed-a50bbf993055",
    "wireMessageId": "019b2a70-f225-721c-835f-67175be0667e",
    "receiptOrdinal": "42",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "peerResolutionEventId": "019b2a71-4c18-760a-9017-b3e265aa89d0",
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
- for authenticated input, derive the [channel pair](channels.md#channel-identity)
  from the local DID owning `localKeyName` and the authenticated canonical `did`.
  Validate the local DID against the actual plaintext recipient; missing exact
  DID/key evidence defers dependent projections. Anonymous input has no channel.
  No acceptance/link reference occurs in `message.in`;
  consumers check [operation eligibility](channels.md#operation-eligibility)
  directly after receipt and retain evidence in their concrete intents/results.

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
including a recorded duplicate of an existing channel-local message ID.
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
consistent same-channel key variants, define:

```text
receiptOrderKey(e) = (integer(e.data.receiptOrdinal), e.author)
firstReceiptKey(M) = min(receiptOrderKey(e) for every valid observation of M)
```

Compare the tuples ascending, first by exact integer ordinal and then by the
canonical author string. The minimum is one complete observation key, not
independent minima of its components. ACK-target ordering uses this key only
among targets authorized by the carrier's exact channel or verified successor
path. In a linear single-writer
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

The active runtime commits this event together with its retained objects,
after its exact resolution evidence is durable. Pickup ACK follows channel
receipt under [DD receive](distributed-delivery.md#receive-a-message), whether
channel acceptance is known or pending. Safe hard pre-vault rejection remains
the separate ACK-without-receipt path; failed authentication or unavailable
cryptographic/local prerequisites cannot masquerade as a durable observation.

Channel acceptance, supersession, invitation and denial checks occur after
receipt as required by each consumer. Refusing one operation retains the
received facts and authorizes no other operation; an independent consumer
checks its own source evidence and policy.

<a id="duplicate-transition-and-conflict-rules"></a>

### 10.3 Duplicate and conflict rules

Group by `(canonical sender DID, canonical recipient DID, wireMessageId)` and its deterministic
message ID. Each complete observation authenticates independently with its own
method-valid snapshot and derives the same exact sender/recipient pair. Equal intent hashes
represent one logical input; differences conflict. Transport, author, ordinal,
authorized key and exact plaintext may
differ without creating a new logical input in this same channel. Incomplete
evidence for a consistent sibling neither supplies another execution nor
withdraws an existing complete witness. Contradictory authenticated evidence
remains visible and suppresses new affected work.

Another channel always has another message/execution identity. Verified links,
same bodies and display merges never alias those messages. Local producers
cannot move one outbound wire ID across channels; external peer behavior does
not create a cross-channel exactly-once guarantee.

A pure ACK has Empty type, `{}` body, no attachments, nonempty `ack` and null
`pleaseAck`. It is control input; invalid variants are not treated as pure ACKs.
Receipt/erasure skeletons retain this classification and frozen headers.

<a id="pickup-versus-ultimate-acknowledgment"></a>

### 10.4 Pickup versus ultimate acknowledgment


Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; each wire ID in its validated `ack` array selects an exact local
outbound. The complete channel witness must be in that outbound's channel or a verified
role-preserving successor channel under [section 9.8](#outbound-message-and-delivery-fold).
A conflict-free match may produce an idempotent `delivery.acknowledged`.
A wire ID alone or shared contact grants no ACK authority. A threaded
or natural response without an explicit `ack` array does not create that
delivery observation.

<a id="complete-observation-witnesses"></a>

### 10.5 Complete observation witnesses

For a claim about received evidence, its **complete observation witnesses** are
all committed `message.in` candidates that each satisfy every per-observation
requirement of the consuming schema or fold. Evaluate the required fields and
their exact referenced evidence against one observation at a time. A check
MUST NOT combine a field from one candidate with a field from another. The
result is the set of all complete matches, independent of enumeration order.

The consumer defines the candidate set and its required comparisons and
validation. `ackMessageId` in [section 9.7](#delivery-acknowledged) restricts
candidates to that observation message ID's group. Any complete matching
duplicate can witness that claim. In contrast, `sourceEventId` in a
`message.fromPriorResolved`, `did.rotationSelected`, `message.out` or `profile.nameClaimed`
names one exact observation and cannot replace it with a duplicate. That source
must supply its own complete sender authentication and immutable claims.
The continuity fold may reuse a complete proof witness only under its explicit
same-JWT/context rule; this does not retarget the source reference or combine
incomplete rows. Every exact reference required by a schema must match as specified.

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

For each channel-local logical input, expose complete source witnesses and any
additional acceptance evidence required by its consumers,
receipt order, authenticated intent agreement and its concrete intents/results.
The deterministic execution ID comes from the channel, sender and
wire ID under [delivery](distributed-delivery.md#execution-id-and-immutable-transcript).
An anonymous or mediator-control observation has no application execution.

Each consumer derives pending/refused/eligible status from its exact evidence
and operation rules. At least one complete source witness and no conflicting
authenticated intent is required.
A stored exact source reference cannot borrow another row's fields. New work
also checks current denial, supersession and policy. Read-only ACK/error
observations follow [operation eligibility](channels.md#operation-eligibility).
Keep current eligibility separate from historical intents and completed facts.

Intent conflict requires independently complete authentication, exact DID-pair
agreement and carried-proof evidence for the disagreeing observations.
Keys authorized by different valid Web revisions can therefore still produce
an intent conflict in one logical input. Receipt alone, an unauthorized key or
a still-missing reference cannot establish that conflict or invalidate an
already complete source witness. Retain
those rows with their own pending/refused diagnostics.

Control input, Empty, ping-response and Report Problem can provide complete
ACK witnesses, but never trigger recursive privacy replies.
Erased input creates no new content-derived work. Stable execution tuples
survive ordinary graph extension and display changes. Later links never merge
executions across channels or replay effects.

Recovery may rebuild local projections and show unfinished work. Network or
other external effects require the live initial/manual authority specified by
[dispatch policy](channels.md#fixed-outbound-channel); history is not a queue.

<a id="message-scoped"></a>
<a id="message-accepted"></a>

### 10.7 Operation evidence

Check [operation eligibility](channels.md#operation-eligibility) for each operation.
Automatic `message.out` intents retain their exact source;
`did.rotationSelected` retains its predecessor pair, successor, proof and nullable
source. Neither depends on channel acceptance. `profile.nameClaimed` retains
its exact source and acceptance. ACK observations validate their complete
channel witness and target path.
These records authorize no unrelated operation on the same input.

<a id="13-automatic-effects"></a>

<a id="automatic-effects"></a>

## 11. Automatic effects

[distributed-delivery.md section 11](distributed-delivery.md#automatic-effects) defines effect identity and commit ordering;
[section 8.2](distributed-delivery.md#deterministic-pure-ack) there owns the pure-ACK vector. [Section 9.1](#ids) of this document defines
outbound ID derivation. [relationships.md section 11.1](relationships.md#automatic-response-selection)
owns rotation-notification selection; its [section 13](relationships.md#remote-errors-and-integrity-failures)
defines remote error handling.

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
It releases this message's envelope contribution for every package. Missing
evidence for another package or operation of `M`, and an execution conflict
of an automatic `M`, do not withdraw it or require these bytes again. An ACK
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

1. Acquire exclusive runtime ownership; open/recover SQLite and validate schema,
   metadata, seed wrapper and derived identity under the SQLite profile.
2. Preserve local IDs on ordinary reopen; use fresh IDs on create/restore.
   Discard only unpublished staging and reconstruct held roots before GC.
3. Recover the vault-wide receipt ordinal high-water mark and integrity conflicts.
4. Rebuild channel receipts, verification statuses, exact acceptances, derived links/joins, denials,
   contact channel selections, invitation consumers and source/intent/result projections from saved evidence.
5. Enumerate incomplete references/content and pending/unconfirmed outbounds for
   local recovery and manual action. Reuse their exact intent, channel, proof,
   package and attempt records. Never infer "not sent" from missing history.
6. Rebuild eligible local profile/display projections and permanent erasure closure.
   This work may recover data or resolve a predecessor for a previously
   unverified proof, but grants no protocol dispatch or business effect.
7. Start recipient reconciliation, pickup and permitted synchronization. Enable
   new user sends and manual actions only after normal runtime/evidence checks.

Open/import/restore MUST NOT dispatch historical outbounds, regenerate missing
automatic replies for sending, or take over another replica's outbox. This
includes ACKs, privacy notifications and protocol effects. A duplicate network
delivery of an already retained input is historical work, not a new live trigger.
An explicit user action may retry its frozen eligible package; missing bytes
must first be recovered. The phase-1 single executor restriction remains.
No exactly-once claim is made across loss of the authoritative history.

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
2. choose a fresh UUIDv7 entity ID;
3. derive the fixed authentication and key-agreement keys;
4. build and validate a Peer DID numalgo-4 document encoding those keys and route;
5. commit `did.created` with canonical short form, long form and `boundRouteId`.

There is no role field. A committed ID reuses its exact keys, document and route
after a crash; it cannot be recreated using a new route. A conflicting or retired
entity cannot be silently replaced. Registration of a mediated recipient must
be verified before disclosure. First disclosure uses the long form under
[relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile). Address allocation may prefer another mediator to
reduce linkability, but route choice does not establish channel authority.

<a id="164-disclose-an-address"></a>

<a id="disclose-an-address"></a>

### 13.4 Disclose an address

Create or select a live communication DID under [section 13.3](#create-a-communication-did). Reconcile its
bound route and verify recipient registration, then commit `did.disclosed`
and expose its long form by OOB, QR, file or another discovery transport.
An OOB disclosure also freezes the user's `admitChannel` choice before
publishing the invitation; other disclosure forms store false.
Public discovery SHOULD select an address allocated for that purpose and avoid
exposing an address used privately. These are disclosure policies; the same DID
identity, receipt and acceptance rules apply to either choice.

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

Append `contact.deleted` for the exact contact ID. This hides the display contact
without changing channel acceptance, messages or transport. A product operation
explicitly combining deletion, blocking or erasure additionally records concrete
`channel.blocked` decisions and/or `message.erased` roots selected under the lock.
Keep those decisions independent of future contact membership. Denial can include
verified successors; no shared DID or display name expands its scope.

Late channel receipt may still be saved/pickup-ACKed. Existing channel denial
prevents new automatic work; authenticated ACK observations still use their
target/path checks. Explicit cleanup follows retained message/root rules.
Shared keys/routes are not retired merely because one display contact disappears.

<a id="167-rotate-a-local-relationship-address"></a>
<a id="rotate-a-local-relationship-address"></a>

### 13.7 Rotate a local channel address

1. Select the exact predecessor pair from an existing local DID and canonical
   peer DID, verify exact predecessor confirmation and check current rotation policy.
2. Create a fresh local DID/eligible route and sign one frozen predecessor proof.
3. Commit the successor, then `did.rotationSelected` with `fromDidId`, `peerDid`,
   `toDidId`, nullable `sourceEventId` and frozen `fromPrior`. Recheck lifecycle,
   denial, supersession and conflict under the lock. Selection and notification
   need no channel acceptance. Do not retire shared resources as part of this operation.
4. Commit or reuse the dedicated Empty notification intent naming this rotation
   decision under [delivery](distributed-delivery.md#built-in-independent-operations).
   Verify recipient registration before disclosure and use the initial/manual
   dispatch rules. Other new messages may use the successor; existing messages
   keep their fixed channels.
5. Derive exact-successor confirmation; only then retire unneeded resources.

Reuse an existing complete decision after interruption; missing references defer.
Recovery does not dispatch a notification. Manual completion reuses its existing
intent or creates the one missing notification under the same decision; it never
substitutes another source or successor. Live automatic privacy policy follows
[relationships.md](relationships.md#early-private-address-policy-and-notifications).
Opposite-side rotation uses verified joins, never contact lookup.

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

Compute held roots from the prospective event union and copy only verified
source objects that are absent or known damaged in the target and held by that
fold. Full import publishes events and object additions or repairs under
[event-store.md section 11.3](event-store.md#import-into-an-existing-vault)'s atomic
publication boundary; this semantic union is not permission to expose an
intermediate event-only import.
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
mailbox, and exposes pending outbox records for manual action. Opening never
supplies initial or retry dispatch authority, even after an exact local move.
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
  not a different channel or authentication type.
- A valid `from_prior` is channel-context evidence. It MUST NOT globally
  link or retire addresses used by unrelated channels.
- The phase-1 mediator stores only encrypted inner DIDComm envelopes and
  routing/account-delivery metadata. It does not receive a replica ID.
- Deferred `replica-mediation/1.0` would reveal opaque replica IDs to the
  mediator; deferred `vault-sync/1.0` would add client-side encrypted opaque
  objects.
- The mediator may observe its account DID, recipient DID and method,
  ciphertext size, arrival, pickup, ACK, expiry, IP and traffic timing. It is
  not sent a contact ID.
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
Changing a published field meaning, fold, deterministic ID, erasure rule or key
derivation requires a new vault version.

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
4. <a id="ve-4"></a> Intent freezes channel, sender, recipient, timestamps, exact nullable pleaseAck, ack and supported headers before network work.

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
10. <a id="ve-10"></a> Pre-attempt preparations may differ only within one fixed oriented channel. Every attempted retry uses the first attempted package exactly.

11. <a id="ve-11"></a> Retrying one package preserves identical plaintext, envelope and package
    ID.
12. <a id="ve-12"></a> Transport acceptance produces delivery.submitted with its exact prior attempt reference, never ultimate acknowledgment.

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

15. <a id="ve-15"></a> Authenticated key variants in one sender/recipient/wire-ID input agree on one message identity; different channels never alias.

16. <a id="ve-16"></a> Execution ID derives from canonical sender, canonical recipient and wire ID. Each new operation checks its required evidence and current policy; display membership supplies no authority.

17. <a id="ve-17"></a> Missing required source, endpoint or link evidence defers only the affected consumers. Later validation preserves this channel-local identity and grants no automatic recovery dispatch.

18. <a id="ve-18"></a> Contradictory channel identities or authenticated intents conflict; another recipient DID produces another channel and execution identity. Document revisions alone do neither.

19. <a id="ve-19"></a> Intent conflicts suppress disputed automatic effects and ACK
    processing.
20. <a id="ve-20"></a> Pure ACK, valid Empty rotation notification, protocol-correlated
    Empty/ping-response and no-response errors obey [section 10.6](#inbound-message-and-execution-fold) at every
    address. Their permitted ACK/transition work remains; they create no
    contact or recursive privacy notification. Trust Ping requests remain
    application input.
21. <a id="ve-21"></a> Pure ACK has `pleaseAck == null`; it completes when `delivery.submitted`
    commits under the common rule and creates no ACK loop.
22. <a id="ve-22"></a> Duplicate input creates no new response or dispatch action. A pending response needs explicit manual retry; submission permanently ends its work.

23. <a id="ve-23"></a> Resolution and channel receipt commit before pickup ACK; missing or refused channel acceptance does not withhold it.

24. <a id="ve-24"></a> Local/cryptographic prerequisites wait without pickup ACK; continuity waits after authenticated receipt. Retired exact keys may drain eligible routes independently of contacts.

25. <a id="ve-25"></a> Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.

<a id="peer-evidence-and-relationship-formation-ve-26-ve-37"></a>

### Peer evidence and channel acceptance (VE-26–VE-37)

26. <a id="ve-26"></a> `peer.resolved` retains exact canonical document bytes under their raw CID,
    presented/canonical DID forms and selected key IDs, including for external
    `did:web` peers.
27. <a id="ve-27"></a> Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
28. <a id="ve-28"></a> Public discovery uses a chosen communication address under disclosure
    policy. Private allocation is not a different DID schema or receive path.
    Local Peer discovery needs no DNS.
29. <a id="ve-29"></a> First and later inputs use common authentication/resource checks. Channel acceptance is independent of control types and wire age.

30. <a id="ve-30"></a> Unknown application types and absent receipt requests do not prevent channel receipt. Automatic output needs complete source evidence and operation-specific policy checks without channel acceptance; profile lifts and received ACK/error observations retain their acceptance requirement.

31. <a id="ve-31"></a> The first message uses its ordinary application protocol with no custom
    rendezvous wrapper or wire contact ID.
32. <a id="ve-32"></a> message.in records exact channel/authentication evidence. Automatic intents directly reference their source; profile results additionally reference channel acceptance. Carried-proof eligibility derives from exact document associations and endpoints without acceptance.

33. <a id="ve-33"></a> Sending to a peer and receiving from it use the same local/peer pair within a vault. The other vault observes the reversed local/peer roles; message identity preserves sender/recipient direction.

34. <a id="ve-34"></a> Display contact tombstones survive rediscovery; independent channel denials survive regrouping. Receipt in an unaccepted channel creates no replacement contact.

35. <a id="ve-35"></a> First channel receipt accepts absent or past wire expiry. Outbound expiry
    independently stops unsubmitted work at equality.

36. <a id="ve-36"></a> Receipt survives crash before acceptance/display work. Recovery rebuilds saved evidence without redelivery or automatic outgoing effects.

37. <a id="ve-37"></a> channel.accepted stores exact channel/local DID/decision-time resolution, nullable source and explicit basis. Same-pair decisions may retain different valid document revisions; each source/basis validates independently.

<a id="address-changes-and-default-responses-ve-38-ve-49"></a>

### Address changes and default responses (VE-38–VE-49)

38. <a id="ve-38"></a> Local `from_prior.iss` uses the predecessor's long form and its protected
    `kid` has that exact DID portion. Peer verification matches validated
    predecessor spellings and method IDs under [section 6.4](#relationship-peertransitioned), without changing
    the referenced snapshot or JWT bytes.
39. <a id="ve-39"></a> `from_prior.sub` equals plaintext `from` byte-for-byte; before confirmation
    both use the successor's Peer-DID long form.
40. <a id="ve-40"></a> Proof verifies against its exact message.fromPriorResolved document CID and original JWT. Link derivation needs no acceptance; inheriting acceptance additionally requires a matching predecessor acceptance. iat never selects a snapshot and recovery cannot substitute current resolver bytes.

41. <a id="ve-41"></a> Successor/local decision and exact package commit before disclosure, and an attempt commits before transport invocation. Links themselves have no commit boundary.

42. <a id="ve-42"></a> Trust Ping is the default no-content initial message; an application
    message may be first without wrapping.
43. <a id="ve-43"></a> A live early-privacy notification uses its original source execution and dedicated rotation tuple, independent of pure ACK and Ping reply. Generic pure ACK requests no ACK.

44. <a id="ve-44"></a> A new user message may select an eligible public/private successor channel; existing messages and frozen proof time do not change.

45. <a id="ve-45"></a> New unconfirmed successor packages carry their frozen proof/long form. An attempted package never changes after confirmation.

46. <a id="ve-46"></a> Invalid upper-layer evidence refuses acceptance/effects while retaining independently authenticated receipt; failed unpack creates no message.in.

47. <a id="ve-47"></a> Public channels can send before a first reply. Every intent fixes its oriented channel, and display preferences never substitute another at preparation.

48. <a id="ve-48"></a> A channel link never globally retires or aliases a public DID used by unrelated channels.

49. <a id="ve-49"></a> Different communication DIDs may use independent immutable mediation routes.

<a id="lifecycle-erasure-and-restore-ve-50-ve-55"></a>

### Lifecycle, erasure and restore (VE-50–VE-55)

50. <a id="ve-50"></a> Desired registration includes live DID/route pairs. Retained eligible old routes can drain receipt without requiring continuity history.

51. <a id="ve-51"></a> Each local DID derives fixed authentication and key-agreement keys and
    an immutable bound route. Rotation creates another entity; the local
    allocator selects its independent route when creating the successor DID.
52. <a id="ve-52"></a> Erasure is checked before object presence; late roots receive equivalent
    erasure closure.
53. <a id="ve-53"></a> SQLite restore creates fresh local IDs, restores state and reconciles pickup, but pending outbounds require manual action. Exact moves require a stopped source and also grant no dispatch by opening.

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
59. <a id="ve-59"></a> Committed receipt/content survives immediate restart before pickup ACK even with no accepted channel or contact.

60. <a id="ve-60"></a> ACK lookup validates the exact outbound fixed channel and a role-preserving path from its peer to a carrier with a complete channel witness; shared contact/wire ID alone is insufficient.

61. <a id="ve-61"></a> Every committed inbound carries a durable phase-1 receipt ordinal. ACK arrays
    use `firstReceiptKey`; clock rollback does not reverse receipt order in a
    linear history, and cross-author ties have deterministic recovery order.
62. <a id="ve-62"></a> Channel acceptance follows explicit inbound/outbound/invitation policy or verified links. It supplies evidence for profile lifts, received ACK/error observations and invitation consumption, while preparation, automatic output and rotation remain independent. Erasure retains its exact decision evidence without freezing later keys.

63. <a id="ve-63"></a> Within-channel authorized variants share one execution; another channel stays separate after graph discovery. Regrouping and retirement never rewrite existing IDs.

64. <a id="ve-64"></a> Committed submission remains complete after restart, loss of local caches,
    clock rollback, package retirement, content erasure and envelope collection.
    Retained event skeletons prevent resubmission or replacement of that message ID.
65. <a id="ve-65"></a> One package's committed `delivery.submitted` completes its entire message ID and
    suppresses every other package's preparation or submission. Workers
    serialize dispatch per message ID and commit acceptance before further dispatch.
66. <a id="ve-66"></a> The inbound message ID vectors in [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) recompute to
    `336032bf-0c6e-5ce7-a3ed-a50bbf993055` and
    `fb01c09c-f8c5-5c62-b5b4-a8017500a2d8` from their published inputs.
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

73. <a id="ve-73"></a> Matching proof-free channel acceptance consumes a local one-use invitation. Receipt alone consumes nothing; crash/erasure preserve the committed consumer.

74. <a id="ve-74"></a> ACK membership uses fixed outbound channel/direction and exact package/path evidence; wire-ID equality alone cannot acknowledge it.

75. <a id="ve-75"></a> Known DID or wire ID does not bypass missing source authentication, endpoint or required proof evidence; response prerequisites must already be committed. A complete source witness needs no channel acceptance to support automatic output.

76. <a id="ve-76"></a> Open discovers retained unfinished input/output for local recovery and manual action without mediator redelivery; it never automatically dispatches effects.

77. <a id="ve-77"></a> A known duplicate can record a new channel observation but cannot recreate
    a tombstoned contact. A conflicting duplicate supplies no new executable
    work; its prior history remains.

78. <a id="ve-78"></a> An authenticated, correlated no-response error produces no reply; its explicit ACK may independently record receipt. Later rotation or blocking does not erase that observation or ACK evidence.

79. <a id="ve-79"></a> Crash recovery rebuilds local receipt/policy/proof state without redelivery or automatic protocol effects. A saved response cannot become a different-channel notification.

80. <a id="ve-80"></a> Distinct events sharing a receipt `(author, ordinal)` pair remain history
    with a projected receipt-integrity conflict, not a full-import failure.
    Only affected logical messages are excluded from newly frozen ACK targets.
81. <a id="ve-81"></a> Every event-set permutation produces the same complete receipt ordering; older same-channel duplicates affect future selection only, never frozen ACK arrays.

82. <a id="ve-82"></a> A receipt may later gain exact channel acceptance via explicit policy or verified links; missing lookup or matching pthid alone grants none.

83. <a id="ve-83"></a> Same-consumer invitation reuse does not create another take. Imported
    incompatible consumers leave it unavailable; event order chooses no winner.
84. <a id="ve-84"></a> contact.merged and contact.channelsSet change display only; channel acceptance, operation evidence, executions, ACK authorization, denials, invitation and erasure facts remain unchanged.

85. <a id="ve-85"></a> Matching pthid alone, foreign recipients and continuation bases consume no invitation. A complete qualifying channel acceptance consumes its exact local disclosure.

86. <a id="ve-86"></a> Attempt evidence is portable and committed before transport. Reopen/import of queued, prepared or attempted-unconfirmed work grants no send. A manual retry uses exact bytes and cannot infer prior nondelivery.

87. <a id="ve-87"></a> A user send or deterministic response uses its outbound message ID as plaintext
    `id`; every package and retry preserves it. Inbound observation message IDs remain
    scoped derivations and are not replaced with the received wire ID.
88. <a id="ve-88"></a> A successor freezes its own route at DID creation. Crash before commit may
    choose again; afterward recovery reuses that exact document and route.
    Preference changes do not edit it.
89. <a id="ve-89"></a> Retirement and receipt rechecks serialize. Retained eligible old keys can receive; new sending/acceptance obey lifecycle and old invitation consumption survives.

<a id="transition-evidence-and-automatic-intent-ve-90-ve-100"></a>

### Transition evidence and automatic intent (VE-90–VE-100)

90. <a id="ve-90"></a> message.fromPriorResolved contains only exact sourceEventId and documentCid, retaining that object as its root. did.rotationSelected contains exactly fromDidId, peerDid, toDidId, nullable sourceEventId and frozen fromPrior. Channel links derive from these inputs without stored link IDs or acceptance dependencies.

91. <a id="ve-91"></a> Erasure preserves exact channel acceptances, proof-document associations, source JWTs and local decisions. Independent evidence roots retain issuer documents; missing bytes defer instead of selecting replacements.

92. <a id="ve-92"></a> Two automatic intents for the same `(executionId, effectType)`
    have one effect key and message ID. Different intent hashes conflict after any
    permutation of their union; both variants and their packages remain history,
    with preparation and submission suppressed.
93. <a id="ve-93"></a> Equal effect keys and intent hashes with different fixed channels, sender or recipient fields conflict; exact duplicate intents count once.

94. <a id="ve-94"></a> An automatic intent whose execution ID disagrees with its unique carrier
    group's derived ID, whose effect type or intent violates the producing
    protocol's operation rules, whose key disagrees with its tuple, or
    whose message ID disagrees with its key is invalid and cannot execute.
95. <a id="ve-95"></a> Every inbound-derived message.out retains executionId, effectType, effectKey and exact sourceEventId. Reopen validates the complete source witness and recomputes the key without acceptance; missing tuple or required evidence cannot authorize work. Locally initiated sends have these four fields null and ack == [].
96. <a id="ve-96"></a> Pure ACK, Ping reply and rotation notification have distinct fixed effect types and may coexist for one input in every import order, including the two outputs with the same Empty message type. Conflicting intents for one `(executionId, effectType)` suppress that operation without suppressing the others; a source intent conflict suppresses all source-derived operations.
97. <a id="ve-97"></a> A supported no-response error is shown only with exact accepted channel/path and protocol thread correlation. It does not change submission or authorize replay; erasing its body removes that diagnostic.

98. <a id="ve-98"></a> Supported public DIDs can establish explicit channel acceptance without Peer-specific spellings; private allocation remains optional policy.

99. <a id="ve-99"></a> A direct input and an input at a rotated channel have different execution IDs even with equal wire IDs. Reopen or graph recovery never merges or repeats their saved effects.

100. <a id="ve-100"></a> Source, local endpoint records, required proof evidence and any rotation decision must commit before a dependent intent. Acceptance is not an intent prerequisite. A proposed same-batch prerequisite or intermediate fold row grants no authority or dispatch.

<a id="key-binding-and-resolution-regressions-ve-101-ve-111"></a>

### Key, binding and resolution regressions (VE-101–VE-111)

101. <a id="ve-101"></a> Canonical key encoding governs authentication and method membership. Channel/message IDs use canonical DIDs and channel direction, not selected public-key bytes.

102. <a id="ve-102"></a> Selecting recipient keys or assigning display contacts cannot prove inbound authentication. Anonymous/control/pending inputs retain evidence without application execution.

103. <a id="ve-103"></a> message.out requires immutable senderDidId and recipientDid; their canonical endpoints determine its channel. Different endpoint values conflict even if intentHash agrees; rotation never retargets it.

104. <a id="ve-104"></a> Ordinary user sending and preparation need no channel acceptance or first reply. Their fixed intent and exact package evidence retain the channel through document update, reply, submission, erasure and restore.

105. <a id="ve-105"></a> Successful same-DID resolution with a newly authorized usable key permits preparation and receipt using their own exact evidence without channel acceptance. Definitive resolution failure retains the scoped failure path; revoked keys cannot authenticate new delivery.

106. <a id="ve-106"></a> Keys independently authorized by different valid Web revisions may authenticate the same channel input. Equal intent deduplicates and contradictory intent conflicts; another channel never merges execution.

107. <a id="ve-107"></a> Channel selectors preserve local/peer roles and compare canonical DID strings; key encoding and display IDs cannot change the pair.

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
109. <a id="ve-109"></a> Control type alone creates no channel acceptance, contact or privacy link. A control input with a complete channel witness may supply permitted ACK evidence without recursive notifications.

110. <a id="ve-110"></a> Retained old recipient keys can receive. No usable authorized sender means no automatic response intent; later recovery exposes manual work instead of sending or retargeting it.

111. <a id="ve-111"></a> message.in/prepared derive peer keys from exact peerResolutionEventId. Sender/recipient/wire-ID message identity does not use key bytes; missing non-null references defer and anonymous input alone has null sender evidence.

<a id="local-rotation-and-relationship-histories-ve-112-ve-124"></a>

### Local rotation and channel history (VE-112–VE-124)

112. <a id="ve-112"></a> A local rotation decision freezes the old local DID, canonical peer, successor, proof and nullable source without acceptance. A non-null source must match the exact predecessor pair; a manual decision retains that pair with no source. Its derived link changes one endpoint; successors use UUIDv7.

113. <a id="ve-113"></a> A local link needs complete exact-address confirmation against the authenticated peer context without acceptance. The confirming observation needs no handler decision or output intent and cannot rely on the decision or its descendants to establish its context.

114. <a id="ve-114"></a> New successor preparation uses frozen proof until exact confirmation. Attempted packages remain unchanged; overlapping recipient routes stay until no retained channel/disclosure needs them.

115. <a id="ve-115"></a> Local rotation changes new intent selection only. Queued, prepared, attempted and submitted messages keep their oriented channel; a new-channel send needs a new ID.

116. <a id="ve-116"></a> Equivalent DID replacements are idempotent across valid document revisions; same-side branches, dependency cycles and contradictory identity evidence conflict. Missing predecessor acceptance defers only acceptance-dependent consumers, not complete links, automatic output or preparation.

117. <a id="ve-117"></a> Verified role-preserving paths can authorize successor ACKs for fixed old outbounds; they do not merge source executions and display membership supplies no path.

118. <a id="ve-118"></a> A shared DID can belong to unrelated channels. Only evidence-backed opposite-side joins justify new channel combinations; no global Cartesian-product or component identity is assumed.

119. <a id="ve-119"></a> A peer carrier establishes its exact channel link or verified join context without acceptance. Proof-free input uses its own authentication evidence and exact DID pair; each operation checks any additional evidence it requires.

120. <a id="ve-120"></a> A complete receipt can witness a peer link before any handler runs or channel acceptance exists. Restoring its exact missing proof document or endpoint evidence permits local validation without inventing a new global identity.

121. <a id="ve-121"></a> Operation eligibility is computed from current policy and evidence. Concrete operation references must form a complete witness; missing exact references defer and contradictory identity/intent conflicts without moving effects or reopening invitations.

122. <a id="ve-122"></a> Complete opposite-side links from one exact predecessor pair justify their diagonal join in either import order without acceptance; same-side competing successors remain conflicts.

123. <a id="ve-123"></a> Direct contact channel selection is independent of channel acceptance, may be edited offline and grants no cryptographic authority.

124. <a id="ve-124"></a> A local privacy rotation decision names the exact eligible source selected while live. Repeated evidence preserves it; its link derives without a new event and recovery never dispatches a missing notification.

<a id="recipient-eligibility-and-evidence-recovery-ve-125-ve-131"></a>

### Recipient eligibility and evidence recovery (VE-125–VE-131)

125. <a id="ve-125"></a> The common DID schema has no role member. Every address pair uses the same channel receipt/acceptance rules and private allocation still avoids reuse.

126. <a id="ve-126"></a> Peer supersession refuses new old-peer work through its verified local-only context. Earlier source evidence, intents and results remain; unrelated public-DID channels are unaffected.

127. <a id="ve-127"></a> Resolution and receipt commit in dependent steps before acceptance. Acceptance/evidence/invitation decisions serialize under the lock; crash prefixes never authorize automatic recovery dispatch.

128. <a id="ve-128"></a> Confirmation in an unrelated channel does not permit short-form disclosure. Exact predecessor verification evidence and validated DID spelling equivalence govern JWT method comparison.

129. <a id="ve-129"></a> Incomplete continuity does not block authenticated receipt/pickup ACK. Recovered predecessor evidence validates local links; invalid paths grant no acceptance and failed unpack remains pre-receipt.

130. <a id="ve-130"></a> Given the same validated numalgo-4 long form L and short form S, every
     stored resolution document uses id=L, preserves input alsoKnownAs entries
     before appending S, fills omitted method controllers with L and leaves
     relative references unchanged. Embedded methods, explicit external
     controllers, array order and input contexts are preserved as in [section 4.4](#peer-resolved). No resolver-added context or absolute-reference variant is stored.
     Long/short receipt, restore and repeated proof processing reproduce one
     RFC 8785 byte string and raw CID, without a spurious document conflict.
131. <a id="ve-131"></a> Supported methods without canonicalization preserve exact DID strings; case/encoding/trailing-dot differences cannot collapse channels or proof context, and did:web document IDs must match exactly.

<a id="contact-profiles-ve-132-ve-137"></a>

### Contact profiles (VE-132–VE-137)

132. <a id="ve-132"></a> Contacts aggregate explicitly selected channels and may display verified related history. Shared DIDs/keys do not transfer channel acceptance or profile-sharing authority; presentation never changes source channel labels.

133. <a id="ve-133"></a> profile.nameClaimed contains exactly sourceEventId, channelAcceptanceEventId and name; its channel derives from the source. Its exact complete source/channel witness supplies the name; incomplete/invalid evidence contributes none. Existing lifts survive body erasure and later denial, while new lifts require readable content and current permission.

134. <a id="ve-134"></a> profile.shared names an exact outbound in its fixed channel with valid attempt/submission evidence. Intent, attempt or ACK alone is insufficient, and later rotation cannot mark another channel as shared.

135. <a id="ve-135"></a> Profile ordering follows minimum complete canonical source keys; same-channel duplicates and import order never advance an old claim by lift time. Different names for one logical source conflict.

136. <a id="ve-136"></a> Per-channel profile projections expose claimedName, nameConflict and latest shared source key. Display aggregation retains each source channel and grants no send authority.

137. <a id="ve-137"></a> Readable eligible missing profile lifts can rebuild locally after reopen, with outbound submission checked. Erased/denied input supplies no new lift; no recovery lift dispatches a message.

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
139. <a id="ve-139"></a> ACK timing considers every carrier with a complete channel witness authorized for the exact outbound, including successor-channel carriers; unrelated/invalid rows donate no timestamps.

### Group waits and transition validity (VE-140–VE-142)

140. <a id="ve-140"></a> A complete proof witness can derive a peer link while an equivalent sibling lacks evidence. An acceptance with a missing exact basis/source waits; reuse of a proof requires the explicit complete-witness rule and never assembles incomplete rows.

141. <a id="ve-141"></a> A complete predecessor observation remains a valid confirmation when another observation later appears at a successor channel. Those messages have distinct identities; missing successor evidence cannot erase the predecessor witness.

142. <a id="ve-142"></a> Conflicting authenticated intent within one sender/recipient/wire-ID execution suppresses new intents for every effect type without undoing submission or collecting disputed bytes. Different channels never merge into this conflict.

### Completion witnesses and address confirmation (VE-143–VE-144)

143. <a id="ve-143"></a> A complete valid attempt/package/submission witness preserves completion despite unrelated incomplete packages or later effect conflict. Invalid/missing own intent, authentication or attempt evidence completes nothing.

144. <a id="ve-144"></a> Proof-free new successor preparation requires complete exact-address confirmation in the valid channel context. Confirmation needs no acceptance or handler decision; body erasure and waiting siblings erase no complete witness.

### Direct contact channel selections (VE-145–VE-149)

145. <a id="ve-145"></a> contact.channelsSet contains exactly contactId and a sorted duplicate-free channels array of canonical localDid/peerDid pairs with empty roots. Every import order selects the latest canonical whole set; a later empty set clears it and concurrent sets are not unioned.

146. <a id="ve-146"></a> Two contacts may select the same channel without a conflict or canonical contact election. Editing one set does not change the other; merging their views preserves each contact's decisions and shows each logical message once.

147. <a id="ve-147"></a> A membership event neither creates a missing contact nor restores a tombstoned one. Contact deletion hides that contact even after later set events; channel receipt, acceptance, messages and explicit denials remain independently available.

148. <a id="ve-148"></a> Selecting an unaccepted channel is valid presentation state. Missing channel evidence remains unresolved; membership cannot supply endpoints, authentication, acceptance or dispatch permission.

149. <a id="ve-149"></a> A contact with multiple eligible channels requires a concrete channel choice before intent commit. A local-DID preference that still matches several options, overlapping contact views and contact merges do not choose one or retarget existing messages.

### Concrete operation evidence (VE-150–VE-153)

150. <a id="ve-150"></a> An automatic intent's missing exact source or required endpoint/proof evidence defers that intent even if another duplicate could independently authorize equivalent work. Importing the missing evidence completes its witness; lookup never replaces saved references. Missing acceptance alone does not defer it.

151. <a id="ve-151"></a> A complete ACK carrier acknowledges its exact outbound through a valid channel path independently of handler execution. Later blocking or peer supersession preserves that evidence while current policy can refuse new outgoing work.

152. <a id="ve-152"></a> A dedicated notification requires rotationEventId and uses that decision's successor and peerDid. An inbound-triggered notification uses its exact source in the fromDidId/peerDid pair; a source-free manual notification has null effect/source fields and a UUIDv7 message ID. Neither requires acceptance. Different notification IDs for one decision conflict without affecting an independent ACK tuple.

153. <a id="ve-153"></a> A saved intent, profile result or rotation decision supplies no generic permission for another operation on the source. New work checks current policy separately; ordinary later policy changes do not erase the saved record or submission.

154. <a id="ve-154"></a> Profile claims derive their pair from the exact inbound source and matching acceptance; profile sharing derives it from the exact outbound source. Missing source endpoint evidence defers attribution. The same peer at another local DID receives no inferred name or sharing fact.

155. <a id="ve-155"></a> contact.channelsSet sorts complete canonical localDid/peerDid tuples by their specified encoding. Duplicate pairs, equal endpoints, noncanonical spellings and extra selector fields are invalid; an empty set clears selection and missing documents grant no processing authority.
