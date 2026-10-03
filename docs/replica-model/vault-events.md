# The Estoc vault events, version 4

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide)
<!-- suite-navigation:end -->

Status: **phase 1**. The event vocabulary of one single-seed vault
executed by exactly one active writable full runtime. The folds over the
events and the procedures that append them are code; see
[section 13](#folds-and-procedures).

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

Every example below is the `type`, `roots` and `data` portion of an event
whose complete envelope is defined by [event-store.md](event-store.md). Object CIDs and
retention semantics are defined by [dasl-objects.md](dasl-objects.md). A known event
type has a closed payload schema in version 4. The store itself validates
only the envelope; the vault layer validates the payload before append
and after ingest.

This document defines portable vault state. Socket state, pickup cursors,
retry timers, caches and traces are local state and do not appear here.
[channels.md](channels.md) owns channel identity, invitations and the channel
event payloads; operation eligibility is the linked modules' code. Receipt
precedes source-derived decisions and continuity work.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

Each domain places its event schemas together; the fold and procedure
columns link the module that owns each rule.
Shared vocabulary is in [section 3](#identity-seed-and-key-names); cross-document rule ownership is listed in
the [suite guide](README.md#rule-ownership). The table is a navigation aid.

| Domain | Definitions and event schemas | Folds | Procedures |
| --- | --- | --- | --- |
| Identity and naming | [Identity, keys and identifier types](#identity-seed-and-key-names); [Identity label](#identity-label) | [Runtime author](#runtime-author-fold) | [Open runtime](../../packages/agent-core/src/identity.ts) |
| Mediation and DIDs | [Key evidence and resolved documents](#message-keys-and-peer-evidence); [Mediation and DID events](#mediation-communication-dids-and-routes) | [Mediation](../../packages/vault/src/fold/mediation.ts); [Replicas](../../packages/vault/src/fold/replicas.ts); [DIDs and keys](../../packages/vault/src/fold/dids.ts) | [Establish mediation](../../packages/agent-core/src/mediation.ts); [Enroll a replica](../../packages/agent-core/src/replica-enrollment.ts); [Create and disclose a DID](../../packages/agent-core/src/dids.ts) |
| Channels and continuity | [Source evidence and directed links](#relationships-and-address-changes) | [Channel and continuity projections](#relationship-fold-and-address-index) | [Channel and display policy](relationships.md#symmetric-relationship-identity); [Early privacy policy](../../packages/agent-core/src/privacy.ts); [Rotate local address](../../packages/agent-core/src/rotate.ts) |
| Contacts and application views | [Contact events](#contacts); [Channel selections](#contact-channelsset) | [Application views](#application-message-views); [Contacts](../../packages/vault/src/fold/contacts.ts); [Contact views](../../packages/vault/src/fold/views.ts) | [Delete contact](../../packages/vault/src/procedures.ts) |
| Messages and delivery | [Stored content](#stored-message-document); [Outbound events](#outbound-message-events); [Inbound events and witnesses](#inbound-message-events) | [Inbound execution](../../packages/vault/src/fold/inbound.ts); [Outbound delivery](../../packages/vault/src/fold/outbound.ts) | [Send](distributed-delivery.md#send-an-ordinary-message); [Receive](distributed-delivery.md#receive-a-message); [Recover receipt](distributed-delivery.md#receive-recovery) |
| Invitations | [Disclosure](#disclosure) | [Invitation availability](../../packages/vault/src/fold/invitations.ts) | [Discovery](relationships.md#out-of-band-discovery); [Receipt](../../packages/agent-core/src/receive/receipt.ts) |
| Erasure and retention | [Erasure and held roots](#erasure-and-collection) | [Held-root rules](#held-roots) | [Erase message](../../packages/vault/src/procedures.ts) |

<details>
<summary>Contents</summary>

- [1. Model](#model)
- [2. Principles](#principles)
- [3. Identity, seed and key names](#identity-seed-and-key-names)
- [4. Message keys and peer evidence](#message-keys-and-peer-evidence)
- [5. Mediation and communication DIDs](#mediation-communication-dids-and-routes)
- [6. Channels, continuity and contact membership](#relationships-and-address-changes)
- [7. Contacts and application views](#contacts)
- [8. Stored message document](#stored-message-document)
- [9. Outbound messages and delivery](#outbound-message-events)
- [10. Inbound messages and execution](#inbound-message-events)
- [11. Automatic effects](#automatic-effects)
- [12. Erasure and collection](#erasure-and-collection)
- [13. Folds and procedures](#folds-and-procedures)
- [14. Merge and restore](#merge-and-restore)
- [15. Privacy and security boundaries](#privacy-and-security-boundaries)
- [16. Versioning](#versioning)

</details>
<!-- reading-guide:end -->

<a id="model"></a>

## 1. Model

A vault is one identity with one seed. Phase 1 permits exactly one active
writable full vault runtime at a time. That runtime may run in a local
application or on a server and can derive every vault-controlled
communication and mediation key.

The local runtime has a `replica_id`, used as its event author. A portable
restore creates a new author so imported history remains distinguishable from
new local events.

The event model distinguishes three kinds of durable statement:

- **intent** — a user or policy decision that must survive offline and process
  failure, such as `message.out` or `contact.petname`;
- **observation** — a fact learned from authenticated bytes or an external
  service, such as `message.in`, `mediation.granted` or
  `delivery.acknowledged`; and
- **materialization** — selected work made durable, such as the exact
  ciphertext named by `message.prepared`.

All current views are folds over immutable events. No portable mutable record
is authoritative.

<a id="principles"></a>

## 2. Principles

1. **Intent precedes effects.** A user-visible action is committed as an event
   and referenced objects before DNS, DID resolution, encryption or network
   submission begins.
2. **Observations carry their evidence boundary.** A peer observation carries
   the local and peer keys directly or through retained evidence references.
   Application views retain their source attribution. A mediator observation
   names the mediation arrangement that produced it.
3. **Portable folds have no current-runtime parameter.** Event `author` is
   provenance, not ownership of communication state.
4. **Mediation and communication keys are vault-scoped.** The active full
   runtime derives them from the vault seed and can have the account hold
   its addresses, receive and expose pending delivery for explicit manual action.
5. **Stable IDs identify exact manual retries.** A logical message, an encrypted package
   and a mediator delivery have different IDs and different lifetimes.
6. **Duplicate work is expected.** Manual retry and mailbox redelivery may repeat work; recovery grants
   no automatic dispatch action. Folds and handlers
   must be idempotent.
7. **Conflicts are visible projections.** Concurrent or contradictory
   decisions remain events. A fold uses set semantics, explicit references or
   canonical latest-wins exactly where this document says so.
8. **Events are permanent; content may be erased.** An erase releases object
   roots. It never deletes a skeleton event.
9. **`replica_id` is not a security boundary.** It does not revoke a copied
   seed or create a second identity.
10. **A mediator is not the vault.** Mailbox ciphertext has bounded retention.
    The readable event/object set is the recovery source.

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
| `replica/<replicaId>/me` | DIDComm identity of one replica toward the mediator of a replica-mediation arrangement |
| `did/<id>/authentication` | signing/authentication key for one communication DID entity |
| `did/<id>/key-agreement` | DIDComm key-agreement key for one communication DID entity |

In `did/...` names, `<id>` is the DID entity ID: a UUIDv7 minted for a new
address, or a UUIDv5 derived under the DID entity rules of
[section 3.4](#entity-ids-and-reproducible-uuidv5-namespaces). In
`mediation/<id>/me`, `<id>` is the arrangement ID, the UUIDv5 the mediator's
DID derives under the same section. Version 4 defines exactly one
authentication key and one key-agreement key per communication DID entity.
Key names are never renamed or reused. A `did/...` or `mediation/...`
name does not encode a contact, replica, domain owner or process location.

A `replica/...` name is the one name that says which replica holds it: it
derives the DID under which that replica alone picks up mail
([`replica.created`](#replica-created)). No payload field carries it. Every
`localKeyName` is a `did/...` or `mediation/...` name, so what arrives at a
replica's own DID never becomes a portable observation.

Changing a communication DID's keys or embedded service creates another
`did:peer:4` entity. A local `did.rotationSelected` under
[section 6.4](#relationship-localtransitioned) authorizes a successor channel
for new intents; existing intents retain their channel and may become
undispatchable. There is no local
communication-key generation or key-generation selection. Store generations
retain their separate storage meaning.

TLS private keys, DNS credentials, ACME account keys and web deployment
credentials are not vault communication keys and MUST NOT be derived from
these names.

<a id="replica-ids-and-authors"></a>

### 3.3 Replica IDs and authors

Each writable full vault runtime has one canonical UUIDv7 `replica_id`. Every
event it appends has:

```text
event.author = local replica_id
```

Phase 1 has exactly one active writer. The runtime may execute in an end-user
application or on a server; its location does not change event semantics.
Authorship needs no creation event or separate host identity. A
[`replica.created`](#replica-created) records only that a replica is enrolled
in a replica-mediation arrangement.

A portable restore mints a new replica ID unless it is an exact move and the
old writer is permanently stopped. If two writable copies share an author,
[event-store.md](event-store.md) treats their divergent event sets as an author fork when they
meet during import.

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

The purposes and resulting namespace UUIDs are these; the first three are
unchanged from version 3:

| purpose | namespace UUID |
| --- | --- |
| `inbound-message` | `4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6` |
| `message-execution` | `6511fc66-4d39-589e-b2c7-7185a807b6c6` |
| `automatic-mid` | `8847bd57-5907-5bcd-9a71-d1e97cee3199` |
| `mediation` | `ef3354b7-959d-5de2-a68d-f475ff7a7ab4` |
| `did-entity` | `47c0b363-2cc9-5e29-8898-0cb3cffa2ac2` |

A deterministic entity rule then computes:

```text
UUIDv5(estocNamespace(purpose), UTF8(RFC8785(name_array)))
```

`name_array` is the exact JSON array specified by that rule. RFC 8785
canonical UTF-8 gives unambiguous nulls, strings and field boundaries. A
runtime MUST derive and verify the namespace UUID from the URI above rather
than trusting a copied table constant. The table is a test vector, not a
second source of truth.

Where a rule below takes a DID, `N(did)` is its canonical spelling: the short
form of a `did:peer:4`, whichever spelling arrived, and any other DID as it
is. A value that is no DID, or a `did:peer:4` in neither form, is no input.

<a id="mediation-arrangement-rule"></a>

#### Mediation arrangement rule

```text
mediationId(mediatorDid) = UUIDv5(
  estocNamespace("mediation"),
  UTF8(RFC8785(["v1", N(mediatorDid)]))
)
```

A vault has one arrangement with a mediator, and this is its ID: every
replica that arranges with the mediator derives the same ID, the same
account key name and so the same account, and their `mediation.created`
events are one creation under the
[mediation fold](../../packages/vault/src/fold/mediation.ts). The ID outlives the arrangement: once it
is retired, there is no other ID under which to arrange with that mediator.

The mediator's identity is `N(mediatorDid)`. Wherever a mediator or routing
DID is compared — creations of one arrangement, its grants, the arrangement
a document's routing DID is looked up by, a replica grant's `mediator`
against the arrangement's — the comparison is of `N` of each side: a valid
long and short spelling of one `did:peer:4` are one mediator, never a second
mediator or a disagreeing grant. Each event keeps the spelling it was
written with, and no event or CID is rewritten to canonicalize it: a long
form is the material its short form resolves from. Comparing identities
replaces no check of a document, hash or signature.

Test vector: `did:web:mediator.example` gives
`1922ce3b-533a-5c75-8cb1-10cdd1f80204`.

<a id="did-entity-rules"></a>

#### DID entity rules

```text
successorDidId(predecessor) = UUIDv5(
  estocNamespace("did-entity"),
  UTF8(RFC8785(["v1", "next", N(predecessor)]))
)

startDidId(publicDid, binding) = UUIDv5(
  estocNamespace("did-entity"),
  UTF8(RFC8785(["v1", "start", N(publicDid), N(binding)]))
)
```

`predecessor` is the DID of the local entity a successor follows;
`publicDid` is a public address of this vault and `binding` the peer DID a
relationship under it is bound to. `publicDid` equal to `binding` is no
input.

The successor rule names the predecessor's DID, not its entity ID: the DID
commits to the whole document, keys and route alike, so replicas rotating
from one DID arrive at one successor whose key names and keys agree. Equal
successor documents take more: the allocating procedure must choose the same
document-builder inputs, the route among them, which the ID derivation does
not select. The peer's current DID is no input to the successor rule: replicas
learn of a peer's rotation at different times and would otherwise part.
`"v1"` names the derivation profile: this transcript together with the key
derivation of [section 3.2](#single-seed) and the numalgo-4 document
builder; a change to any of the three is a new version string, and entities
already created keep their IDs.

These rules define the IDs. Which rule a procedure uses, if any, is that
procedure's own: the procedures of this version mint a fresh UUIDv7 for a
new address, and the fold does not check whether a UUIDv5 entity ID follows
a rule.

Test vectors, over the delivery fixture's DIDs
`did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd` (ours) and
`did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP` (the peer's):
`successorDidId(ours)` is `24ae4bcc-e4ee-5111-b600-1674a2300462` and
`startDidId(ours, peer)` is `4cb0f38a-668b-5472-b82c-509b397c8058`.

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
| One exact event envelope | `EventCid` | derived API/row `cid`, outside the envelope |
| Typed event reference | `EventReference<T>` | payload fields ending in `EventCid` and elements of `*EventCids`, including source, trigger, resolution, disclosure and rotation references |
| Contact | `ContactId` | `contactId`, `fromContactId` |
| Local/peer DID pair | `Channel` | `channels` entries; `localDid` and `peerDid` in selectors |
| Local DID entity | `DidId` | `didId`, `senderDidId`, `fromDidId`, `toDidId` |
| Mediation arrangement | `MediationId` | `mediationId` |
| One prepared package | `PackageId` | `packageId` |
| Scoped mediator delivery | `DeliveryId` | `deliveryId` |
| Sender/recipient-scoped automatic execution | `ExecutionId` | `executionId` |
| Exact content bytes | `Cid` | `bodyCid`, `attachmentCids`, `documentCid`, `envelopeCid`, `dropCids`; generic object APIs use `cid` |
| Vault keystore name | `KeyName` | `localKeyName`, `me.keyName` |
| Complete canonical public-key value | `PublicKey` | `peerPublicKey` |
| DID string / verification-method DID URL | `Did` / `DidUrl` | `did`, `localDid`, `peerDid`, `recipientDid`, `presentedDid`, `longFormDid`, `fromDid`, `toDid` / `authenticationMethodIds`, `keyAgreementMethodIds` |

For every payload `*EventCid`, `T` is the target event type fixed by the
referencing schema. `sourceEventCid` is `EventReference<"message.in">` in
`did.rotationSelected`, `message.admitted` and `message.out`;
`fromDidId` and `toDidId` in `did.rotationSelected` name local DID entities;
`rotationEventCid` in
`message.out` names `did.rotationSelected`. The referencing schema also owns
presence and nullability; a nullable reference has the same typed non-null
value. Generic event-store APIs use `EventCid`. Every event reference is a
canonical raw DASL CID validated against the target's canonical envelope when
available. An event CID identifies an event row; an object CID identifies object
bytes. Using the same hash profile does not add event references to `roots` or
require event envelopes to be stored in `ObjectStore`.

Use the same entity noun for creation and later references: `did.created.didId`
and `did.disclosed.didId`, for example. Add a role prefix when needed, such as
`senderDidId`. Payloads do not abbreviate a contact ID as `cid`, or hide an
entity ID behind a bare `id`, `contact` or `mediation` field.
`cid` and `*Cid` always mean content addresses; `*Did` always means a DID
string, while `*DidId` means a local entity UUID. Arrays of references use the
plural suffix, such as `attachmentCids`; collections of view
records retain their own names and carry typed identifiers in each record.

The type distinction is part of the API contract. One possible TypeScript
representation is below; other languages may use equivalent nominal types.
`EventCid` and `AuthorId` come from [event-store.md section 3](event-store.md#the-event), and `Cid` from
[dasl-objects.md section 6](dasl-objects.md#objectstore).

```ts
type EntityId<Kind extends string> = string & { readonly __entity: Kind };
type MessageId = EntityId<"message">;
type ContactId = EntityId<"contact">;
type Channel = { localDid: Did; peerDid: Did };
type DidId = EntityId<"did">;
type MediationId = EntityId<"mediation">;
type PackageId = EntityId<"package">;
type ExecutionId = EntityId<"execution">;
type WireMessageId = string & { readonly __wireMessageId: unique symbol };
type DeliveryId = string & { readonly __deliveryId: unique symbol };
type KeyName = string & { readonly __keyName: unique symbol };
type PublicKey = string & { readonly __publicKey: unique symbol };
type Did = string & { readonly __did: unique symbol };
type DidUrl = string & { readonly __didUrl: unique symbol };
type EffectKey = string & { readonly __effectKey: unique symbol };
type EventReference<T extends string> = EventCid & { readonly __eventType: T };
```

Identifiers serialize as validated strings without wrapper objects or type
prefixes. `Channel` serializes as a record of two canonical DID strings. Parsers
and derivation functions produce them only after the owning format checks.
A cast is not validation. Resolve an event reference by its exact CID and check
the target's required event type and domain evidence. Do not substitute another
event with equal payload fields or equivalent normalized meaning. Conflicting
domain facts remain separate events and are evaluated by the owning fold.
An event-reference type records its required target type; missing evidence still defers and
incompatible evidence still conflicts under the referencing schema. It is
never proof that the target is available or valid. `effectKey` is the existing
derived idempotency key, not a keystore name or a cryptographic public key.

Message identity has three levels. An event `cid` names one exact envelope;
identical envelopes are one event. Repeated receipt is a new event under its
own time and author, so a distinct event CID with one `messageId`; one writer
recording one envelope twice within a millisecond records one event.
An inbound `messageId` names the exact sender/recipient/wire-ID input; accepted
key variants in that channel share one execution. Different channels never
alias message or execution identities.
An outbound `messageId` is also its plaintext `id`; no duplicate
`wireMessageId` field is stored on `message.out`. Inbound wire IDs have the
sender's scope and are stored separately. `packageId` names a prepared
package; `envelopeCid` addresses its bytes. `localKeyName`, `peerPublicKey`
and a verification-method DID URL are separate kinds of value and cannot be
substituted for one another.

This vocabulary applies to vault payloads. The event envelope's `author` and
`roots`, serialized local-file fields such as `replica_id`, and wire/protocol fields retain their
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
the immutable issuer document derived under [section 6.3](#relationship-peertransitioned) and its authentication
methods directly. Selection alone is not evidence
of authenticated inbound traffic or remote receipt.

The executable key fixture used by this specification is X25519, public-key
codec `0xec` (unsigned-varint bytes `ec01`), with these 32 raw public-key bytes:

```text
0900000000000000000000000000000000000000000000000000000000000000
peerPublicKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
```

`message.in` and `message.prepared` store `localKeyName` and `peerResolutionEventCid`, with
no `peerPublicKey` payload field. Their peer key is derived as
`peer.resolved(peerResolutionEventCid).peerPublicKey`. For an anonymous
inbound only, null `peerResolutionEventCid` yields null `peerPublicKey`; an unavailable or
invalid reference is deferred or conflicted, never treated as anonymous.
In this document and the delivery profile, a message or package's `peerPublicKey`
always means this derived value. `peer.resolved` and ACK observations retain
their explicit keys. Continuity links derive from exact proof evidence and local decisions.

`message.in.presentedDid` preserves the wire spelling, and
`peer.resolved.presentedDid` preserves the spelling used for resolution.
First-disclosure validation and recovery use this retained evidence.
A verified link may justify a new channel without changing earlier message IDs.
Equal key values under different DIDs do not supply channel authority or a
contact assignment. Each observation retains its own key evidence, and each
consumer checks its own prerequisites.

<a id="mediation-key-evidence"></a>

### 4.2 Mediation key evidence

Traffic between the vault and a mediator uses a local key beginning with:

```text
mediation/
```

These observations belong to the mediation fold, not application
channels or contact/application views.

<a id="11-peer-and-profile-observations"></a>

<a id="peer-and-profile-observations"></a>

<a id="43-peer-and-profile-observations"></a>

<a id="resolution-observations"></a>

### 4.3 Resolution observations

Resolution observations retain exact cryptographic evidence. Peer continuity
links follow the same rule in [section 6.3](#relationship-peertransitioned).
These facts remain distinct from contact assignments and local DID entities.

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
    "presentedDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "did": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "documentCid": "bafkrei...resolved-did-document",
    "authenticationMethodIds": [
      "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP:z...bob-input-document#authentication-0"
    ],
    "keyAgreementMethodIds": [
      "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP:z...bob-input-document#key-agreement-0"
    ],
    "service": "did:web:mediator.example"
  }
}
```

This event is durable resolution evidence for one authenticated or selected
peer key. `localKeyName` identifies the local communication key/context.

- `presentedDid` is the exact numalgo-4 DID string supplied for resolution.
- `did` is its canonical short form under [the peer DID profile](relationships.md#peer-did-numalgo-4-profile);
  first disclosure keeps the long form in `presentedDid`.
- `documentCid` names the raw DASL object containing exact RFC 8785 canonical
  resolved DID document JSON. Its CID commits to those bytes.
- the selected or authenticated `peerPublicKey` must be present under the named DID and exact
  document;
- `authenticationMethodIds` and `keyAgreementMethodIds` enumerate all methods authorized
  for those purposes in the exact retained document, with references resolved
  against that document's `id`. They do not prove every listed key controlled the
  observed message. Each consuming message references its
  own exact evidence; method lists from different documents MUST NOT be unioned
  into an authorization set; and
- `service` is the selected DIDComm service URI or null.

Receipts and packages retain exact resolution references for the immutable
peer document. The receipt's `peerResolutionEventCid` authenticates the current
sender only; predecessor JWT verification derives its issuer document under
[section 6.3](#relationship-peertransitioned) using the same canonical representation.
The referenced resolution objects
remain historical evidence; another document cannot replace any reference.
If the event or object is temporarily missing, processing is deferred until
verified recovery material is available; absence is not proof that the
referenced evidence is invalid.

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
the retained bytes or CID. Method-ID comparison follows [section 6.3](#relationship-peertransitioned).

Equivalent duplicate observations are harmless. Same document CID with
incompatible contents is an integrity conflict; a different
document under one immutable Peer DID is invalid method evidence.

<a id="mediation-communication-dids-and-routes"></a>

## 5. Mediation and communication DIDs

Mediation arrangements, communication DIDs and their private keys belong to
the vault. Their meaning never depends on the event author or the process
executing the full runtime. DID-document publication is outside vault state.

All communication DIDs have the same send, receive and continuity
semantics. The core stores no public/pairwise role. Disclosure records and
local address-allocation policy describe whether an address is public or was
created for private use with one peer. Where a DID sends is the one
DIDComm service of its own document, a mediator's routing DID or a direct
endpoint. Resolving an external mediator DID, including
`did:web`, does not create a local DID entity or a publication obligation.

<a id="mediation-events"></a>

### 5.1 Mediation events

<a id="mediation-created"></a>

#### `mediation.created`

```json
{
  "type": "mediation.created",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "mediatorDid": "did:web:mediator.example",
    "me": {
      "keyName": "mediation/1922ce3b-533a-5c75-8cb1-10cdd1f80204/me",
      "did": "did:peer:4zQm..."
    }
  }
}
```

This intent creates the stable vault-controlled identity for one mediation
arrangement. `mediationId` is the ID `mediatorDid` derives under the
[mediation arrangement rule](#mediation-arrangement-rule); any other value
is an invalid payload. `me.keyName` MUST use the arrangement ID and `me.did`
MUST match the seed-derived key.

Every arrangement is an account of the mediator's replica-mediation protocol,
whose mail each replica picks up under its own DID. `me.did` is recorded as a
`did:peer:4` long form; a short form is an invalid payload. The payload names
no profile: there is one kind of arrangement.

Replicas that each arrange with one mediator record one creation: creations
under one `mediationId` whose `mediatorDid` agree under `N` and whose `me`
are identical are one creation, whichever spelling of the mediator each
replica was given, and the fold reads them as one. Repeating the arrangement
ID with another `me` is an integrity conflict. There is no second
arrangement with one mediator.

<a id="mediation-granted"></a>

#### `mediation.granted`

```json
{
  "type": "mediation.granted",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "routingDid": "did:peer:2.Ez..."
  }
}
```

This is the durable observation that the mediator granted the arrangement
and returned `routingDid`. For a replica-mediation arrangement it is the
observation of the mediator's `account-registered` reply, recorded once, and
`N(routingDid)` equals `N(mediatorDid)` of the arrangement; any other value
is a conflict.

Grants of one arrangement whose routing DIDs agree under `N` are one grant.
More than one routing DID under `N` for one arrangement ID is a conflict. The
runtime MUST NOT guess which grant is authoritative, and no later grant
chooses one: the arrangement stays in conflict.

<a id="mediation-selected"></a>

#### `mediation.selected`

```json
{
  "type": "mediation.selected",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204"
  }
}
```

This is the user's or policy's preferred mediation for newly minted
mediated DIDs. The latest event by canonical order wins.

Selection does not stop old arrangements from receiving. Any mediation
that routes a retained DID remains required.

<a id="mediation-retired"></a>

#### `mediation.retired`

```json
{
  "type": "mediation.retired",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "because": "replaced"
  }
}
```

Retirement is terminal for the arrangement ID, and the ID is the one the
mediator's DID derives: the vault does not arrange with that mediator
again. A procedure SHOULD give every DID routed through it a successor
first. A DID whose document sends to the retired arrangement's routing DID
waits under [the DID fold](../../packages/vault/src/fold/dids.ts); the fold never changes
a DID's document.

<a id="replica-created"></a>

#### `replica.created`

```json
{
  "type": "replica.created",
  "roots": [],
  "data": {
    "replicaId": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "grant": "<compact JWS>"
  }
}
```

This intent enrolls one replica in a replica-mediation arrangement. It MUST
be committed before the first `replica-add` request for that binding. Creating
an empty account with `account-register` does not require this intent to be
committed first. Before registering the account, the client validates any
existing local binding and the candidate grant; an invalid or conflicting
candidate MUST NOT cause a network request. A failed account registration
leaves a runtime with no prior replica binding free to choose another
arrangement. The intent records membership, not remote acceptance: what the
mediator confirmed is runtime state, and no event repeats per attempt.

The replica's DID is a `did:peer:4` whose input document carries the two keys
`replica/<replicaId>/me` derives and exactly one DIDComm service, the
arrangement's `mediatorDid`. The same replica at another mediator is therefore
another DID.

`grant` is the compact JWS the mediator's `replica-add` takes. Its protected
header is exactly `alg: "EdDSA"`, `typ: "estoc/replica-grant+jws"` and `kid`,
a DID URL naming an authentication method of the account under either spelling
of the account DID. The method is one a mediator reads an Ed25519 key from:
type `Multikey` or `Ed25519VerificationKey2020` with that key as its
`publicKeyMultibase`, or type `JsonWebKey2020` with it as a public OKP
`publicKeyJwk`. A signer chooses no other method, even one carrying the same
key. Its payload is the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) text of exactly these
string members:

| member | value |
| --- | --- |
| `account` | the short form of the arrangement's `me.did` |
| `mediation_id` | the arrangement ID |
| `mediator` | the arrangement's `mediatorDid` |
| `replica_id` | the replica ID, a canonical UUIDv7 |
| `replica_did` | the short form of the replica's DID, never the account |
| `replica_long_form` | the long form of `replica_did` |

The whole compact JWS is at most 16384 characters, its two separators
included: a mediator refuses a longer one unread. Every DID a grant carries is
also at most 8192 UTF-8 bytes, which alone does not keep the JWS within its
limit. A signer returns no grant over either limit. `replicaId` and
`mediationId` MUST equal the grant's. A payload whose grant is not spelled this
way, a payload that is not I-JSON included, is invalid; whether its `kid`, its
signature and its replica hold is the
[replica fold's](../../packages/vault/src/fold/replicas.ts).

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
    "longFormDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document"
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
- the input document's one DIDComm service is the DID's route under
  [section 5.3](#delivery-routes), a mediator's routing DID or an absolute
  HTTPS or WSS direct endpoint;
- seed-derived public keys MUST match that document; and
- changing keys or route creates another DID entity and an explicit scoped
  transition.

The entity has exactly two validated spellings: `did` and `longFormDid`.
External document claims establish no additional equivalence.

The long form is disclosed before the short form is relied upon by a peer.
The short form is canonical for vault references and mediator recipient
registration after the mapping is known.

A communication DID entity ID is a UUIDv7 minted for a new address, or a
UUIDv5 derived under the [DID entity rules](#did-entity-rules); which a
procedure uses is that procedure's rule, and the procedures of this version
mint. Same ID with different identity fields is an integrity conflict.

<a id="delivery-routes"></a>

### 5.3 Where a DID sends

A communication DID's document names exactly one DIDComm service, and
that service is the DID's route: a mediator's routing DID, under which
the DID is routed by the mediation arrangement whose grant names that
DID, or an absolute HTTPS or WSS direct endpoint. The route is part of
the document, so the long form fixes it; nothing beside the document
records it and no event changes it. A transport or mediation change
creates successor DID entities, allowing old and new DIDs to overlap
during cutover. Each affected channel context uses its own
[section-6.5](#relationship-localtransitioned) local decision for new
intents; mediation selection does not migrate existing DIDs.

A direct endpoint routes to a full vault runtime or an ingress service.
It MUST NOT identify one replica as the DIDComm application recipient.
Minting the DID does not itself register a recipient.

One rendezvous DID and many pairwise DIDs may send through the same
arrangement or endpoint, which is how they reuse a mediator or direct
ingress without sharing an application identity.

A mediated DID is routed by the usable arrangement whose grant names its
routing DID. A usable arrangement is routed through its own mediator, and
a vault has one arrangement per mediator under the ID the mediator's DID
derives, so one arrangement at most routes a DID. While none does, the DID
waits: the creation or the grant that makes that arrangement usable may not
have been replicated here yet, so the fold MUST NOT end a mediated DID's
receipt on the arrangement's account. Once the arrangement routing a DID is
retired or in conflict, the DID waits as well, and no arrangement with that
mediator follows it. Restoring communication takes a successor DID, never
a change to the old entity.

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
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb",
    "goal": "Write to Alice"
  }
}
```

`as` is `oob` for an OOB invitation or `direct` for a DID shared without one,
regardless of audience or publication medium. `oobId` is REQUIRED for `oob` and null otherwise;
`goal` is nullable. `didId` names a local DID entity under
[section 3.5](#identifier-and-reference-vocabulary), which retains its spellings.
Any live communication DID may be disclosed. An invitation is reusable: whoever
holds it writes to the disclosed DID in a channel of their own, and no receipt
takes it from the next; [the invitation fold](../../packages/vault/src/fold/invitations.ts) says whether
the DID still takes one.

An `oobId` MUST identify one local disclosure. Republishing an invitation reuses
that disclosure; a new invitation receives a new `oobId`. Distinct disclosures
with the same non-null `oobId` are an entity conflict, and republishing under
that ID is refused.

This permanently records disclosure. A mediated DID MUST have current
verified recipient registration before disclosure. Reusable/public disclosure
SHOULD use a discovery address and SHOULD NOT expose an address allocated for
private communication. These privacy policies grant no cryptographic authority.
First disclosure exposes the validated `did:peer:4` long form.

<a id="did-retired"></a>

### 5.5 `did.retired`

```json
{
  "type": "did.retired",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "because": "address-no-longer-needed"
  }
}
```

Retirement is terminal for new sending and disclosure using this DID.
It does not erase keys, documents, received messages or continuity evidence,
and it takes the DID off no mediator: the DID stays in the desired recipient
set of [the DID fold](../../packages/vault/src/fold/dids.ts), held by its account.

A retained exact local key remains eligible for authenticated channel
receipt, including after DID retirement; a mediated DID's key waits while
no usable arrangement routes it. This rule applies equally to publicly disclosed and privately
allocated addresses. Receipt does not wait for a `recipient-add`: an
addition the mediator has not confirmed to this runtime is asked for on
connection as any is, and that asks nothing new of sending or disclosure.
An invitation on a retired local DID is unavailable.
[the receiver](../../packages/agent-core/src/receive/receiver.ts) owns the receipt gates;
[distributed-delivery.md section 4.3](distributed-delivery.md#receive-a-message) owns the receive procedure.

Retain key/document evidence and usable mediation needed by retained channels.
Channel denials and sender eligibility govern new work. Retained
confirmation may justify an explicitly requested recovery rotation without reviving
the old address. Retirement never erases committed message or delivery evidence;
display contact deletion alone is not a transport or authorization operation.

<a id="12-relationships-and-address-changes"></a>
<a id="relationships-and-address-changes"></a>

## 6. Channels, continuity and contact membership

Channel identity, invitations, continuity links, local denial and contact views
are defined in [channels.md](channels.md).

<a id="121-receipt-and-relationship-evidence"></a>
<a id="receipt-and-relationship-evidence"></a>

### 6.1 Receipt and channel evidence

Channel receipt commits independently. Each source-derived operation rechecks
its exact DID pair, evidence and applicable policy under one vault operation
lock.
Every event reference must
name an already committed event; use returned CIDs, not an assumed same-batch
CID. Release the vault lock before network calls. Per-message dispatch is
separately serialized under [delivery](distributed-delivery.md#send-an-ordinary-message).

<a id="123-relationshipcontactassigned"></a>
<a id="relationship-contactassigned"></a>
<a id="contact-peerdidadded"></a>
<a id="contact-peerdidremoved"></a>
<a id="contact-channelsset"></a>

### 6.2 `contact.channelsSet`

```json
{
  "type": "contact.channelsSet",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "channels": [
      {
        "localDid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
        "peerDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP"
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

Selections may be edited offline; missing evidence leaves an unresolved display
selection. One channel MAY be selected by several contacts, each with its own set.
Membership grants no protocol authority. Derived related history follows
[the channel view rules](channels.md#contact-channels) without rewriting the set.

<a id="112-relationshippeertransitioned"></a>
<a id="relationship-peertransitioned"></a>

### 6.3 Peer proof evidence and continuity

Derive the issuer document and verify each committed carrier's original
`fromPrior` under [the channel evidence fold](../../packages/vault/src/fold/channels.ts). A long-form
issuer supplies its immutable document directly; a short-form issuer requires
the matching retained `peer.resolved` document. The original JWT is event
metadata, and `peer.resolved` independently retains its document root, so
message-content erasure removes neither source of issuer material.
No association, link or trusted verification result is stored as an event.
Verification requires neither handler execution nor a known predecessor channel.

Use the shared proof profile through
[the vault's proof adapter](../../packages/vault/src/from-prior.ts), with
`@estoc/continuity/from-prior` owning parsing, profile checks, signature
verification, creation and receipt binding. The issuer material is its validated
long-form DID: an arbitrary document with the same claimed ID cannot replace
the document encoded in that DID. The retained document/CID must match that
immutable representation.

The proof's `iss` canonicalizes to that issuer and the predecessor peer;
binding requires `sub` to canonicalize to the receipt's authenticated sender.
Long and short spellings of the same DID compare equal, including the DID
portion of `kid`; the method fragment still identifies the authorized
authentication key. Preserve the original JWT, document and presented sender
spellings without rewriting signing input. The package profile accepts optional
`typ` as `JWT` or `application/jwt` without case sensitivity and rejects `exp`
and `nbf`; it evaluates no clock window. These are examples of the shared
profile, not permission for a separate vault parser. `iat` elects no branch.
Local producers additionally use the fixed long-form spellings required by
[local rotation](channels.md#did-rotationselected).

Verification and rebuild follow [the channel evidence fold](../../packages/vault/src/fold/channels.ts).
Restored issuer material can complete a short-form proof only when its validated
long form derives the exact issuer; referenced document bytes can be repaired
only when their canonical CID matches.
Missing material defers verification; an invalid signature, claim, method or
long form grants no proof authority. Repeated evidence for the same predecessor and
successor is the same DID replacement across validated long/short spellings.
Verify each carrier's own authentication references and original JWT against
the immutable documents; another spelling alone is not a competing successor. Shared
keys, current resolution alone and display assignment cannot replace the
channel context and verified proof.

<a id="124-relationshiplocaltransitioned"></a>
<a id="relationship-localtransitioned"></a>

### 6.4 Local continuity decisions

The [did.rotationSelected schema](channels.md#did-rotationselected) defines the
fixed predecessor pair, successor, proof, nullable source and independent
confirmation requirement. Commit it before disclosure under
[the rotation procedure](../../packages/agent-core/src/rotate.ts). Rotation selects
channels for new intents only; existing intents retain their channel and may
become undispatchable under [the continuity fold](../../packages/vault/src/fold/continuity.ts).

<a id="144-relationship-fold-and-address-index"></a>
<a id="relationship-fold-and-address-index"></a>

### 6.5 Channel and continuity projections

Index exact ordered pairs by their canonical local and peer DID strings.
Derive directed links, verified opposite-side joins, local-only supersession contexts and
denials under [channels.md](channels.md#continuity). Edges and verification
statuses are derived; each edge exposes its complete source witnesses.
Missing references defer the affected projection; contradictory identities,
proofs or same-end successors conflict. Message and execution identities remain
fixed when graph history changes.

<a id="7-contacts"></a>

<a id="contacts"></a>

## 7. Contacts and application views

A contact uses a `contactId` to organize [selected channels](#contact-channelsset),
names and preferences independently of protocol authority.

<a id="contact-ids"></a>

### 7.1 Contact IDs

See [relationships.md section 5.1](relationships.md#contact-ids).

<a id="contact-event-schemas"></a>

### 7.2 Contact event schemas

Direct channel selections use `contact.channelsSet` in
[section 6.2](#contact-channelsset).

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

Commit this event together with an initial non-empty `contact.channelsSet`.
Selection may precede receipt, outbound intent or peer resolution. Imported
creation without its membership remains valid with an empty selection until
that membership arrives; later sets may be empty under [section 6.2](#contact-channelsset).

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

This selects among eligible channels for a new send under [the contact view](../../packages/vault/src/fold/views.ts)
without changing `contact.channelsSet`. Publicly disclosed addresses may send;
private allocation follows [the private-address policy](../../packages/agent-core/src/privacy.ts).

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

This is a display-only grouping hint between `contactId` and `fromContactId`.
A UI MAY group their views; each retains its ID, decisions and channel set.
The hint MUST NOT affect attribution, DID selection, protocol identity or
authority, deletion or erasure.

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
<a id="114-profileshared"></a>
<a id="profile-shared"></a>
<a id="145-relationship-profile-fold"></a>
<a id="relationship-profile-fold"></a>
<a id="application-message-views"></a>

### 7.3 Application message views

Applications MAY derive display data from retained messages under a supported
protocol and local display policy. The protocol defines fields, interpretation
and ordering. Every value retains its exact source and channel; inbound claims
require a complete source witness and consistent logical intent under
[the inbound fold](../../packages/vault/src/fold/inbound.ts). Missing evidence
defers attribution; conflicting evidence supports no verified claim. Duplicates
and cache rebuilds neither create facts nor advance their ordering.

Ordinary chat, peer-profile fields and incoming ACK/error projections additionally
require effective application admission of their exact source. Unadmitted
observations belong to labelled diagnostics, not accepted application data.

A peer name must come from a protocol-recognized field and remains a peer claim.
It creates no contact, changes no `contact.petname` and grants no sharing
permission. To display a profile as submitted, require a protocol-recognized
`message.out` and complete committed submission evidence; this proves no peer receipt.

Caches must be rebuildable from retained sources. Read content through
[section 12.2](#reading-content).
Erasure invalidates values requiring the erased bytes, even if another message
retains the same object. Retained metadata and delivery records still support
their own facts; explicit petnames remain separate. Missing or erased evidence
does not prove information was never shared. Aggregation retains source-channel
attribution and grants no cryptographic authority or sharing permission.
Rebuilding or losing a view grants no dispatch action.

<a id="stored-message-document"></a>

## 8. Stored message document

Message application content is stored as one whole-resource raw DASL object
containing UTF-8 RFC 8785 canonical JSON. Version 4 uses the following closed
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

A user send mints one UUIDv7 `messageId`. Its package uses it as plaintext `id`.
Outbound events do not store a second `wireMessageId`. Inbound observations keep
their scoped message ID and the received wire ID under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity); the equality applies only to locally authored outbound messages.

An automatic effect derives:

```text
messageId = UUIDv5(
  8847bd57-5907-5bcd-9a71-d1e97cee3199,
  RFC8785(["v1", effectKey])
)
```

The resulting `messageId` is also the response's wire ID. Preparation and manual
retry preserve this ID and its fixed channel. Equivalent automatic effects
therefore identify one logical response.

<a id="message-out"></a>

### 9.2 `message.out`

```json
{
  "type": "message.out",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "senderDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "recipientDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
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
    "sourceEventCid": null,
    "rotationEventCid": null
  }
}
```

`senderDidId` and `recipientDid` are REQUIRED and immutable. Under the operation
lock, select an eligible local DID entity and a peer DID before intent commit.
Their canonical pair fixes the channel under [channel identity](channels.md#channel-identity).
`recipientDid` retains the exact supplied spelling, including a validated Peer
long form for offline preparation; canonicalize it for channel/package comparison.
Selection requires no resolver lookup; preparation retains its own peer evidence.

An automatic output selects the source's channel or a verified role-preserving
successor under [the continuity fold](../../packages/vault/src/fold/continuity.ts).
A UI may select through a contact, but its ID is not protocol identity. The
fixed address fields are excluded from the intent hash and included in full
event equality.

Requirements:

- `createdTime` and `expiresTime` are Epoch-Seconds integers or null;
- when both are non-null, `expiresTime` is strictly greater than
  `createdTime`;
- null `createdTime` omits the DIDComm `created_time` header;
- `pleaseAck` is null or the exact ordered wire array; `ack` is `[]`, or,
  for a pure ACK or an explicit ACK another application protocol defines,
  exactly the source carrier's wire ID under
  [distributed-delivery.md section 8.1](distributed-delivery.md#the-ack-target);
- `headers` contains every otherwise-unmodeled supported top-level DIDComm
  header and no reserved field, including `return_route`;
- `bodyCid` names the canonical stored message document;
- `attachmentCids` is the distinct ordered list of object-backed attachment
  payload roots from that document; link-only descriptors add no entry;
- `roots` is the distinct ordered set of `bodyCid` followed by `attachmentCids`;
- `intentHash` is computed under [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes);
- `executionId`, `effectType` and `effectKey` are all
  null for a locally initiated send and all non-null for an inbound-derived
  protocol effect, including explicit completion of pending response work;
- `sourceEventCid` is required and non-null for an inbound-derived effect,
  otherwise null. It names one exact already committed `message.in` forming a
  complete source witness. Its logical input derives `executionId`; its actual
  channel is the output channel or a verified role-preserving predecessor.
  Authentication and required proof evidence must be complete independently
  of the intent;
- `rotationEventCid` is required and non-null exactly for a dedicated rotation
  notification. It names an already committed `did.rotationSelected`; sender,
  recipient and notification fields obey [the built-in operation rules](distributed-delivery.md#built-in-independent-operations).
  If that decision has a trigger, the intent's `sourceEventCid` equals the
  decision's `sourceEventCid`, whose channel matches its `fromDidId`/`peerDid`,
  and its effect tuple uses that source. Without a trigger, the source reference
  and all three effect fields are null; the locally initiated intent still
  names the rotation.
  An ordinary message carrying the selected proof is not a notification and
  keeps `rotationEventCid == null`;
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
    "recipientDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "peerResolutionEventCid": "bafkreiefyoi7yed7cmfo7woi5kahpw7zu7uq6pj6avn4lgkbfwalkoxl7a",
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
  has complete local-key and peer-resolution evidence;
- `localKeyName` is that entity's key-agreement key and authorizes the plaintext
  `from` under the exact spelling used by the package;
- the plaintext `id` equals `message.out.messageId`; its other semantic fields
  and immutable control headers equal the committed intent;
- `intentHash` equals the intent value;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- the canonical sender and recipient must equal the intent's fixed endpoints
  in the same roles under [channel identity](channels.md#channel-identity);
- `peerResolutionEventCid` names the exact `peer.resolved` evidence used to select
  the recipient key; its `peerPublicKey` supplies the package's derived peer key.
  Its `localKeyName` equals the package's local key and its canonical `did` matches
  `recipientDid`. It is non-null for every phase-1 package, including a
  retained numalgo-4 resolution. Local resolution and evidence reuse follow
  [the DID resolution requirements](relationships.md#did-resolution-requirements);
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization. The `envelopeCid` CID commits to those exact bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

<a id="delivery-attempted"></a>

Committing this event freezes the package for its `messageId`, even before any
transport call. Further `message.prepared` records for that message MUST have
identical payloads and roots, including `packageId` and exact evidence references.
Under the operation lock, reuse an existing preparation and reject a different
one before append. Imported incompatible preparations expose a conflict;
no event order selects a winner. Missing exact evidence or envelope bytes
defers sending and cannot justify another preparation.
A retained package reference whose preparation is missing remains pending;
it is not evidence that no package was selected.

Initial sends and manual retries use this package unchanged under
[dispatch](../../packages/agent-core/src/dispatch.ts). An uncertain commit
must be resolved before dispatch or further preparation. A package records no
transport invocation; call counts and retry diagnostics are local trace.
Submission or message-scoped termination stops preparation and retry. Recheck
lifecycle and security at dispatch without invalidating historical evidence.
Public and pairwise addresses use the same package rules and name no replica.

<a id="delivery-submitted"></a>

### 9.4 `delivery.submitted`

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

This says only that one transport endpoint accepted the package. It does not
mean route existence, mediator retention, pickup or ultimate durable receipt.

The closed data contains exactly `messageId` and `packageId`; `roots` is empty.
`packageId` MUST identify the already committed valid `message.prepared` for
this exact `messageId`. Append this event after observing transport acceptance.
Its successful commit completes the logical outbound under
[the outbound fold](../../packages/vault/src/fold/outbound.ts).
If acceptance happened but this observation did not commit, the outcome remains
unconfirmed and requires explicit manual retry; recovery never resubmits it.

Transport, endpoint and response status are local trace data. They are not
fields of this portable event and do not participate in the delivery fold.

<a id="delivery-failed"></a>

### 9.5 `delivery.failed`

```json
{
  "type": "delivery.failed",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "code": "expired"
  }
}
```

This event terminates an unsubmitted message through expiry or explicit
cancellation. Its closed data contains exactly `messageId` and `code`;
`roots` is empty. `messageId` names the outbound intent.

`code` is exactly one of:

- `expired`: the unsubmitted intent reached its non-null expiry; or
- `cancelled`: an explicit user action cancelled the unsubmitted intent.

An `expired` failure for an intent with null `expiresTime` is invalid and
terminates nothing.

Both codes terminate the entire message, before or after preparation. They
stop all preparation and submission, including manual retry. Termination
requires no package reference or preparation evidence; a preparation imported
later cannot reopen the intent. Further sending requires a new message ID.
A termination never proves nondelivery: an earlier unrecorded call may have
succeeded. Any independently complete submission takes precedence after import.

An explicit cancel action serializes with dispatch for the message, rechecks
submission under the operation lock and appends `code == "cancelled"` only
while unsubmitted. It may cancel before preparation or after an outcome-unknown
call. Cancellation preserves message content.

Resolution and transport failures, the `resolve`/`prepare`/`submit` phase and
retry diagnostics belong only to local trace and retry policy. They MUST NOT append
`delivery.failed`. Losing that local state does not terminate the intent or
change its portable delivery state.

A worker that observes a non-null `expiresTime` with `now >= expiresTime` for an
unsubmitted outbound before prepare or retry appends that expired failure and
submits nothing. It does not
append an expired failure merely because an already-submitted message later
reaches expiry. A later user attempt requires a new `message.out` and wire ID.
Sensitive strings remain in local trace; `code` is a stable non-secret value.

<a id="delivery-acknowledged"></a>

### 9.6 `delivery.acknowledged`

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

The exact carrier is an admitted complete source witness under
[the admission model](../../packages/vault/src/admission/model.ts). Its explicit `ack`
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
    "messageId": "d2192dcf-cc5c-5f7d-b4f1-46972b7b04de",
    "wireMessageId": "019b2a70-f225-721c-835f-67175be0667e",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "peerResolutionEventCid": "bafkreibyv62fswjkyg4ttq2houxa74kghobrly26havhefevacjdud334q",
    "presentedDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "did": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
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
    "receivedVia": {
      "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
      "deliveryId": "01J...opaque"
    }
  }
}
```

Phase 1 records no separate inner-signature evidence. Channel sender authority
requires authenticated encryption under [the receive gate](../../packages/agent-core/src/receive/gate.ts);
an inner signature does not supply an alternative authenticated sender. The
carried `fromPrior` retains its separate continuity-verification role.

Requirements:

- `messageId` is the deterministic observation value above;
- `intentHash` and `plaintextHash` are computed under [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes);
- `localKeyName` is the exact local key that decrypted the message;
- `peerResolutionEventCid` is REQUIRED and names the exact `peer.resolved` used to
  authenticate the sender. It is null exactly for an anonymous observation,
  in which `did`, `presentedDid` and the derived peer key are also null.
  An authenticated sender requires DID resolution evidence; there
  is no DID-less authenticated-key fallback. A non-null reference supplies
  the authenticated peer key under [section 4.1](#key-evidence); its `localKeyName`, `did` and
  `presentedDid` match this observation. Sender authentication and evidence
  reuse MUST satisfy [relationships.md sender freshness](relationships.md#sender-authentication-freshness)
  and [the receipt](../../packages/agent-core/src/receive/receipt.ts).
  Commit/reuse that event and document first, then use its returned event CID
  in the separate inbound commit; later resolutions cannot replace the
  reference. It is local
  evidence metadata, excluded from the message hashes;
- for authenticated input, derive the [channel pair](channels.md#channel-identity)
  from the local DID owning `localKeyName` and the authenticated canonical `did`.
  Validate that local DID/key mapping against the exact local key-agreement
  method that successfully decrypted the authcrypt layer, under the
  [recipient evidence rule](../../packages/agent-core/src/receive/gate.ts).
  The plaintext `to` header is audience information, not recipient evidence;
  its absence or failure to name that local DID does not by itself invalidate
  receipt or change its channel. Missing exact DID/key evidence defers
  dependent projections. Anonymous input has no channel.
- `presentedDid` is the exact DID spelling disclosed on the wire, including a
  Peer DID long form when first seen;
- `did` is the canonical peer DID, using Peer DID numalgo-4 short form after
  validating the long form, or null when no peer DID is available;
- `createdTime`, `expiresTime`, `pleaseAck`, `ack`, `headers` and `fromPrior`
  preserve normalized wire headers; absent `please_ack` is null, a present
  array is retained exactly, absent `ack` is `[]`, and no additional header is
  `{}`;
- `fromPrior` is null when absent, otherwise the exact original string, even
  when it is not a valid JWT. Parsing, claim and signature failures belong to
  continuity verification and do not invalidate this authenticated observation;
- ACK processing reads from `pleaseAck` only whether this message requests its
  own receipt, by `""` or this `wireMessageId`; stored arrays are not rewritten;
- `headers` contains every otherwise-unmodeled permitted top-level member and
  MUST NOT contain any reserved field, including `return_route`;
- `thid` and `pthid` are present with null when absent;
- event `author` identifies the active receiving runtime;
- mediation and delivery ID are null for direct transport without them;
- `bytes` is the canonical retained document byte length; and
- `attachmentCids` is the distinct ordered list of object-backed attachment
  payload roots in the closed stored document; link-only descriptors add no
  entry; and
- `roots` is the distinct ordered set of `bodyCid` followed by `attachmentCids`.

Every newly committed `message.in` is an event of its own, including a
recorded duplicate of an existing channel-local message ID; re-ingest of an
existing `cid` preserves its event. Inbound commit MUST be serialized across
the active writer. A pickup batch follows the per-delivery receipt/admission
ordering in [the receive procedure](distributed-delivery.md#receive-a-message);
this does not permit committing all live receipts before admission.

The observations of one logical message `M`, including consistent
same-channel key variants, are ordered by
[canonical event order](event-store.md#canonical-order), as are the
candidates admission reconciliation walks under
[channels.md](channels.md#application-admission). Define:

```text
firstWitness(M) = the first admitted complete observation of M in canonical event order
```

It is undefined while no admitted complete observation qualifies, and raw
unadmitted duplicates cannot change it. `firstWitness` names the observation
an operation reads the input's fields from and orders established logical
messages for display; it is no admission prerequisite. A pure ACK names its
carrier alone, so no target array is ordered. For successive events of one
writer whose timestamps strictly increase, canonical order follows commit
order. Events sharing a timestamp are ordered by CID, so their canonical
order may differ from commit order even without clock rollback; a clock
rollback may place later commits before earlier commits. What follows that
order is the choice of witness among consistent duplicates, the order
candidates are judged in and display; a committed admission or intent stands
whatever the order. For independently run histories canonical order is a
deterministic merged order, not a claim about physical receive time between
disconnected writers. This rule permits history union; it does not enable
concurrent phase-1 writers or establish multi-writer effect convergence.

A later observation does not reorder earlier events. Learning an older alias
or importing history may change the first witness for future decisions, but
MUST NOT change a committed `message.out`.

Full import MUST NOT reject an event union for repeated observations of one
input. The generic event store remains payload-opaque. Its [section 5.3](event-store.md#ingest)
`ForkedAuthor` check detects unseen events under the current local author; it
does not prove that every historical author is fork-free.

Commit the observation with its objects after its exact resolution evidence.
Pickup ACK follows [the receive procedure](distributed-delivery.md#receive-a-message),
including its separate hard-rejection path. Subsequent consumers independently
check [admission](../../packages/vault/src/admission/model.ts).

<a id="message-admitted"></a>

#### Application admission record

`message.admitted` is the closed, rootless local decision defined by
[channels.md](channels.md#application-admission). Its sole required field is
non-null `sourceEventCid: EventReference<"message.in">`. Receipt commits first;
admission commits before any application projection or input-derived effect.
Preserve both events through export/import and metadata-preserving erasure.
The source retains its own objects; admission introduces no extra roots.
Missing source or verification evidence defers the admission, never completes
it from another observation. Schema validation rejects additional payload
fields, wrong reference types, null references and nonempty roots.

Event order and admission are independent facts. An earlier observation
does not prove acceptance before rotation; use the durable admission record.
Imported historic admissions preserve the originating runtime's decisions,
subject to their exact cryptographic evidence, not today's supersession policy.
New local admissions always check the complete current graph, including when
reconciling restored or imported receipts without admissions.

<a id="duplicate-transition-and-conflict-rules"></a>

### 10.3 Duplicate and conflict rules

Group by `(canonical sender DID, canonical recipient DID, wireMessageId)` and its deterministic
message ID. Each complete observation authenticates independently with its own
method-valid immutable document and derives the same exact sender/recipient pair. Equal intent hashes
represent one logical input. Differences between independently admitted
observations conflict for application use; unadmitted differences remain raw
diagnostics and cannot overwrite admitted content. Transport, author, event time,
authorized key and exact plaintext may
differ without creating a new logical input in this same channel. Incomplete
evidence for a consistent sibling neither supplies another execution nor
withdraws an existing complete witness. Contradictory admitted evidence remains visible and suppresses new affected
application work. Cryptographic continuity conflicts are evaluated independently
of application admission.

Another channel always has another message/execution identity. Verified links,
same bodies and display merges never alias those messages. Local producers
cannot move one outbound wire ID across channels; external peer behavior does
not create a cross-channel exactly-once guarantee.

A pure ACK has Empty type, `{}` body, no attachments, nonempty `ack` and null
`pleaseAck`. This vault produces one whose `ack` names exactly its carrier; a
received one may name several. It is control input; invalid variants are not
treated as pure ACKs.
Receipt/erasure skeletons retain this classification and frozen headers.

<a id="pickup-versus-ultimate-acknowledgment"></a>

### 10.4 Pickup versus ultimate acknowledgment


Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; each wire ID in its validated `ack` array selects an exact local
outbound. The admitted complete source witness must be in that outbound's channel or a verified
role-preserving successor channel under [the outbound fold](../../packages/vault/src/fold/outbound.ts).
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
validation. `ackMessageId` in [section 9.6](#delivery-acknowledged) restricts
candidates to that observation message ID's group. Any complete matching
duplicate can witness that claim. In contrast, `sourceEventCid` in a
`did.rotationSelected`, `message.out` or `message.admitted`
names one exact observation and cannot replace it with a duplicate. That source
must supply its own complete sender authentication and immutable claims.
If that source carries a JWT, it must independently verify under
[the channel evidence fold](../../packages/vault/src/fold/channels.ts). Immutable issuer material may
be shared, but another carrier's authentication or proof result cannot replace
this source's checks. Every exact reference required by a schema must match as specified.

This matching rule does not replace authentication, scope, historical
membership, proof or group-validity checks. A matching candidate cannot clear
a group conflict or bypass a missing-evidence deferral required by the
consuming schema or fold. Incomplete evidence is not a proven mismatch merely
because the candidate cannot yet enter the witness set.

Subject to those checks, an existential claim requires at least one complete
witness. Aggregates use all qualifying witnesses; [the outbound fold](../../packages/vault/src/fold/outbound.ts)
computes ACK receipt time across all qualifying admitted witnesses, including
duplicates and distinct carriers.

Admission is a prerequisite for producing a new source-derived rotation decision
or outbound intent, and for new address confirmation.
Application projections of chat, profile values, received ACKs and Report Problem
correlation also require effective admission of each exact contributing source;
ACK timing and new ACK-target selection use only admitted witnesses.

Validation of a committed `did.rotationSelected`,
`message.out`, preparation or submission requires its own cryptographic and
reference evidence, not source admission. Their derived links,
frozen intents/packages and submitted facts do not become pending or invalid
merely because an admission is absent. A committed local decision still needs
independent complete predecessor-confirming evidence, without an admission
prerequisite for that witness. Missing exact evidence still defers validation.
For a saved pure ACK, validate its one target under
[distributed-delivery.md section 8.1](distributed-delivery.md#the-ack-target)
on the carrier's complete witness, admitted or not.
These records do not grant admission to their sources or populate accepted
chat/profile/ACK views. A saved `delivery.acknowledged` likewise cannot substitute
for the admitted witnesses [the outbound fold](../../packages/vault/src/fold/outbound.ts) requires.

Cryptographic carrier verification and continuity/conflict inspection do not
require admission and cannot supply it. Current policy still governs all new
work and dispatch independently of saved-record validity.

<a id="message-scoped"></a>
<a id="message-accepted"></a>

### 10.6 Operation evidence

The folds in [`packages/vault/src/fold/`](../../packages/vault/src/fold/) define the independent
evidence checks for observations and rotation decisions, and the procedures
that commit intents define their policy checks under
[section 13](#folds-and-procedures).

<a id="13-automatic-effects"></a>

<a id="automatic-effects"></a>

## 11. Automatic effects

[distributed-delivery.md section 11](distributed-delivery.md#automatic-effects) defines effect identity and commit ordering;
[section 8.2](distributed-delivery.md#deterministic-pure-ack) there owns the pure-ACK vector. [Section 9.1](#ids) of this document defines
outbound ID derivation. [Built-in independent operations](distributed-delivery.md#built-in-independent-operations)
owns rotation-notification selection; [the channel view](../../packages/vault/src/fold/views.ts)
owns remote error attribution.

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

Under the operation lock in [event-store.md section 9](event-store.md#vault-interface), the vault runtime computes
the held roots passed to `ObjectStore.collect` in [dasl-objects.md section 8.3](dasl-objects.md#collection).

A root is held when at least one accepted event retains it through `event.roots`,
except where a release rule below applies. Retention is a set fold over the
complete event inventory. Each known event's schema assigns its message/root
contributions. Any valid `message.erased` naming `(messageId, root)` permanently
releases every contribution for that relation, including contributions learned
later. Adding another event cannot revoke that erase or re-hold the same erased
relation. Another message's non-erased contribution can still hold the root.

This section is the sole normative owner of prepared-envelope retention.
For a consistent outbound `M` and valid package `P`, define:

```text
retainEnvelopeForMessage(M, P) =
    !erased(M, P.envelopeCid)
    and !submitted(M)
    and !messageTerminal(M)
```

Terminal means valid committed expiry or cancellation under `delivery.failed`.
It releases this message's envelope contribution independently of preparation
arrival order. Sampling wall time beyond expiry blocks unsubmitted work but
MUST NOT release its envelope until that durable termination is committed.
`submitted(M)` is defined by
[the outbound fold](../../packages/vault/src/fold/outbound.ts) and remains true after envelope collection or termination.
It releases this message's envelope contribution, including competing imported
packages. Missing evidence for another package or operation of `M`, and an
execution conflict of an automatic `M`, do not withdraw it or require these bytes again. An ACK
does not affect retention, including when an outcome-unknown transport attempt
has no `delivery.submitted`.

Unavailable routes, retryable resolution failures and other reversible
scheduling conditions do not release an unsubmitted, non-terminal package.
There is no separate response-replay retention contribution or closure event.
After submission, even a duplicate inbound request cannot require these bytes
again or authorize a replacement package. The message's body/attachments and
its event skeletons keep their separate retention rules; submission or termination
does not erase conversation content or receipt/scope evidence.

`erased(M, root)` names the permanent message/root relation, not global deletion
of a CID. Another independent non-erased reference may retain the same bytes.
Conflicted evidence is not release authority: disputed package roots remain
held until unambiguous release evidence or explicit erasure exists.

Submission eligibility additionally checks current time, addressing,
proof, route and available bytes. Scheduling eligibility is not a retention
predicate.

Unknown event types retain every exact root in their `roots` because version 4
defines no erase rule for them. A CID embedded in object content is not a
retention edge unless it also appears in an accepted event's `roots`.

<a id="154-no-runtime-local-eviction-event"></a>

<a id="no-runtime-local-eviction-event"></a>

### 12.4 No runtime-local eviction event

Version 4 does not represent local body eviction as a portable event. A local
storage policy that deletes a non-erased retained object makes the phase-1
vault incomplete. It may be repaired from a verified portable SQLite import or backup.
Missing bytes never authorize collection of retained roots.

<a id="16-procedures"></a>

<a id="procedures"></a>
<a id="folds-and-procedures"></a>

## 13. Folds and procedures

The folds over these events, and the procedures that decide what to
append, are specified by their code and its tests, not by this document.
Each fold is a module of
[`packages/vault/src/fold/`](../../packages/vault/src/fold/) whose leading
comment states the rule it implements. A fold is deterministic over the
same event set, the verdicts handed to it and its interpretation options,
in whatever order the events arrived: what needs the seed or the retained
objects is checked once beside the fold, in
[`packages/vault/src/fold/vault.ts`](../../packages/vault/src/fold/vault.ts),
and the verdicts are passed in, so the event frontier alone is not the
whole input and a repaired or lost object changes the projection without
a new event. `packages/vault/test/fold/` checks each fold by shuffling.
The procedures that write the vault are
[`packages/vault/src/procedures.ts`](../../packages/vault/src/procedures.ts)
and the modules of
[`packages/agent-core/src/`](../../packages/agent-core/src/); each reads
the fold under the writer lock, decides over it and commits each decision
in one batch. Where one procedure commits twice, such as a rotation and
its notification, its module states what a crash between the commits
leaves. Their tests sit beside them. This document keeps the event schemas
and the retention contract that the folds obey; where a section above
refers to a fold or a procedure, it links the module that owns it.

<a id="merge-and-restore"></a>

## 14. Merge and restore

<a id="171-event-merge"></a>

<a id="event-merge"></a>

### 14.1 Event merge

Merge is event-store set union by event CID. Equal canonical envelopes occur
once, and every reference continues to name the same exact envelope after
export/restore. Distinct events can still contain conflicting domain facts.
It never:

- rewrites an event;
- removes an imported decision;
- treats another author as read-only history; or
- adopts database pages or physical row order as authoritative state.

After merge, every fold reflects the complete union. A cached projection must
be updated or invalidated in the acceptance transaction and rebuilt before use
if invalid; an incremental result must equal the pure fold of that union.

Application admissions remain distinct from raw observations under
[admission and merge](channels.md#application-admission). A complete imported
admission can restore accepted historical state; merely importing an earlier
receipt cannot manufacture it. A newer rotation blocks new old-peer admission
and dispatch without deleting earlier admitted history or submitted outcomes.

<a id="172-object-merge"></a>

<a id="object-merge"></a>

### 14.2 Object merge

Compute held roots from the prospective event union and copy only verified
source objects that are absent or known damaged in the target and held by that
fold. Full import publishes events and object additions or repairs under
[event-store.md section 10.3](event-store.md#import-into-an-existing-vault)'s atomic
publication boundary; this semantic union is not permission to expose an
intermediate event-only import.
No content traversal is implied. An erased message/root relation does not
revive merely because an older source still has the bytes.

Missing non-erased bytes remain an integrity/availability condition and may
be repaired from a verified portable SQLite import or backup.

<a id="174-restore"></a>

<a id="restore"></a>

### 14.3 Restore

A portable SQLite restore creates a new local `replica_id` and
`store_generation`. An exact local move is a separate operation that may retain
them only with the old writer permanently stopped under
[vault-sqlite.md section 12.3](vault-sqlite.md#exact-local-move). The restored
runtime derives the mediation and communication keys named by retained entity
records, enrolls as a new replica of each required arrangement, has the account
hold the required recipients, drains its own mailbox, and exposes pending outbox
records for manual action. Mail the mediator fanned out to the earlier replica
before the restore stays with that replica. Opening never
supplies initial or retry dispatch authority, even after an exact local move.
It also reconciles unfinished committed inbound work under [the open](../../packages/agent-core/src/agent.ts),
including observations already pickup-ACKed before the snapshot. Local queue
state is not a recovery source.

A local DID created after the snapshot, including a privacy successor, may be
absent after restore. The seed alone cannot reconstruct the missing UUIDv7
entity IDs in its key names. Once local recipient state is authoritative,
deliveries with no known or recoverably pending recipient mapping follow the
terminal wrong-recipient gate and its bounded visible diagnostic under
[the receiver](../../packages/agent-core/src/receive/receiver.ts). Such an address stays
held by the account under [the DID fold](../../packages/vault/src/fold/dids.ts); nothing is
taken off the mediator.

A snapshot can omit a known peer rotation and its admission history. In that
case restore cannot reconstruct the missing restriction or the exact past
acceptance boundary from the seed or timestamps. Import newer
evidence when available; never claim rollback-safe rejection from an old
snapshot alone. Existing old-peer admissions preserve historical state, not
permission to send to a peer whose replacement is now known.

A snapshot can predate a peer's successor long form even though the peer has
already received confirmation and now sends its short form. Such a delivery
cannot authenticate after restore and follows the terminal receive gate:
pickup ACK when mediated, no `message.in`, and the bounded visible diagnostic
under [the receiver](../../packages/agent-core/src/receive/receiver.ts). Waiting alone
does not recover the long form. A new long-form disclosure can enable sender
authentication but does not itself recover missing continuity history or a
discarded delivery. Importing a newer complete snapshot may restore retained
evidence; otherwise the channel may need to be established again.

Traffic at a snapshot-era address is not a guaranteed repair. Supersession
can prevent a reply, and eligible live input, including an already queued
message, can trigger another privacy rotation when the snapshot lacks a later
decision. A manual rotation can also select a different successor. If the peer
already verified the lost decision's successor, it can then retain two valid
replacements of the same endpoint in one context. Phase 1 preserves this fork
as a visible conflict under [channels.md](channels.md#continuity), with no
default send head in the affected context and no authority through conflicted
continuity. Restoring the lost decision does not choose between the branches.
Communication may be established independently from a fresh local DID; doing
so does not resolve the old context. Restore UI MUST explain these limits under
[vault-sqlite.md](vault-sqlite.md#restore).

No previous process must be online. Mediator retention still bounds messages
that were never committed to the vault. The seed recovery credential must be
retained independently of the active runtime; a portable SQLite backup includes
its encrypted wrapper. Recovery verification follows
[vault-sqlite.md section 4.2](vault-sqlite.md#recovery-material-and-product-requirement).

<a id="175-forked-author"></a>

<a id="forked-author"></a>

### 14.4 Forked author

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
  a mediator may still involve a network resolver.
- Private-address allocation SHOULD disclose its new DID only in encrypted
  interaction and avoid publishing it in reusable discovery. This is policy,
  not a different channel or authentication type.
- A valid `from_prior` is channel-context evidence. It MUST NOT globally
  link or retire addresses used by unrelated channels.
- The phase-1 mediator stores only encrypted inner DIDComm envelopes and
  routing/account-delivery metadata. The mediator of a replica-mediation
  arrangement is given each enrolled replica's ID and DID in its
  account-signed grant and can group them under the account; it is given
  no application plaintext or content-decryption key, and a communication
  peer learns no local replica ID from that enrollment.
- The mediator may observe its account DID, recipient DID and method,
  ciphertext size, arrival, pickup, ACK, expiry, IP and traffic timing. It is
  not sent a contact ID.
- A direct endpoint sees transport metadata and encrypted DIDComm envelopes;
  it is not an application-level runtime address.
- Ultimate ACKs reveal durable-receipt timing to the peer.
- Event authorship does not authenticate history supplied by another holder
  of the same seed.

<a id="19-versioning"></a>

<a id="versioning"></a>

## 16. Versioning

These event meanings belong to vault version 4. A version-4 reader may
preserve unknown event types but MUST validate every known type according
to this document.

Compatible additions within version 4 may introduce a new event type or
an explicitly optional payload field whose absence has a fixed meaning.
Changing a published field meaning, fold, deterministic ID, erasure rule or key
derivation requires a new vault version.
