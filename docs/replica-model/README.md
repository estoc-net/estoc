# Estoc version 4 specification suite

Status: **version 4, phase 1**. The packages under [`packages/`](../../packages/)
implement it and their tests are the evidence; the folds over the vault's
events and the procedures that append them are specified by that code, see
[vault events section 13](vault-events.md#folds-and-procedures).
Phase 1 has one active writable full vault runtime, seven
specifications. SQLite is the sole persistent vault and portable interchange
format. This guide is informative; linked specification sections define requirements.
The target uses vault version 4 and SQLite schema 2, retaining the version-3
seed wrapper and existing key/domain-ID derivation. Event identity and references
use raw CIDs of five-field canonical envelopes.
Identical envelopes are one event. No old-vault migration is required.

<a id="model-overview"></a>

## Model overview

A vault has one seed, immutable events and raw content-addressed objects.
[Channels](channels.md#model) are ordered local/peer DID pairs. Each receipt and
package retains its own authentication or encryption evidence. Carried proofs
retain their original JWTs and derive their immutable issuer documents. Phase-1 channel
endpoints use immutable `did:peer:4` documents; mediator DID resolution is
independent. Received proofs and local rotation decisions
derive directed links between pairs. Receipt may precede continuity verification,
whose status remains visible.

Operations use their own evidence and policy. An invitation is a reusable
address: no receipt takes it from the next, and no event records who used it.
Contacts organize
selected channels with local names and preferences. Applications derive ordinary display
data only from durably admitted message history under their protocol rules.
Authenticated receipt and application admission are separate facts; ignored
old-peer observations remain available as explicitly labelled diagnostics.
Admission is required for new source-derived operations and application views.
Existing rotation, outbound and submission records retain their
own validity without it. A saved operation cannot supply missing admission for
its source; see [application admission](channels.md#application-admission).

An outbound fixes its channel at intent commit; rotation never retargets it
and can prohibit its preparation or dispatch, including manual retries. Preparation commits one fixed package. Every transport call requires that
package and a live initial/manual action. Recovery exposes pending work for manual
action. Retry preserves the package; a different package or channel requires a
new message ID. Peer ACKs record receipt independently of submission. See
[delivery boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

ACK, Trust Ping reply and rotation notification use independent persisted
intents identified by `(executionId, effectType)`. Each stable operation URI
permits at most one compatible intent per execution.

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage | [Event store](event-store.md), [DASL objects](dasl-objects.md) | Event API, identity/order, object bytes and retention |
| Persistence | [SQLite vault](vault-sqlite.md) | Schema, exclusive ownership, transactions and portable recovery |
| Domain facts | [Vault events](vault-events.md) | Message, delivery, contact and local policy payloads; the folds over them are code |
| Communication authority | [Channels](channels.md), [Address/contact policy](relationships.md) | Fixed DID pairs, invitations, channel event payloads, DID profiles and address policy; the continuity adapter, admission and dispatch authority are code |
| Runtime | [Delivery](distributed-delivery.md) | Channel-local identity, ACK paths, fixed packaging and live dispatch actions |

Ordinary DIDComm messages need no Estoc wire handshake or contact ID.

The [`@estoc/continuity` package](../../packages/continuity/README.md)
implements shared `from_prior` proof verification, creation and context
binding alongside a pure continuity model. Its README defines the package
inputs, queries, replica merge contract and host responsibilities. The
package owns proof and graph semantics. [Channels](channels.md#continuity)
states the application model, and
[`packages/vault/src/fold/channels.ts`](../../packages/vault/src/fold/channels.ts) and
[`fold/continuity.ts`](../../packages/vault/src/fold/continuity.ts) implement its use. Keep
package semantics in its code, public contract and tests; app policy and
storage integration belong in this suite and its code. The package's
[illustrated guide](../../packages/continuity/docs/guide.md) explains its queries
and boundary cases. This app revision supports rotations only, not endings.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [channels and continuity](channels.md#model) → [address/contact policy](relationships.md#what-it-is-for) → [commit/ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity](dasl-objects.md#reading-guide) → [EventStore/Vault](event-store.md#reading-guide) → [SQLite](vault-sqlite.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas](vault-events.md#reading-guide) → [folds and procedures](vault-events.md#folds-and-procedures) |
| Integrate continuity | [Event identity](event-store.md#invariants) → [continuity model](channels.md#continuity) → [channel evidence](../../packages/vault/src/fold/channels.ts) → [continuity fold](../../packages/vault/src/fold/continuity.ts) → [admission](channels.md#application-admission) |
| Implement sending | [Send](distributed-delivery.md#send-an-ordinary-message) → [address selection](relationships.md#ordinary-sending-and-birth-selection) → [package preparation](distributed-delivery.md#preparing-a-package) → [delivery fold](../../packages/vault/src/fold/outbound.ts) |
| Implement receiving | [Receive](distributed-delivery.md#receive-a-message) → [resolution](relationships.md#did-resolution-requirements) → [receive gate](../../packages/agent-core/src/receive/gate.ts) → [evidence](vault-events.md#receipt-and-relationship-evidence) → [source evidence](distributed-delivery.md#address-chains-and-observation-membership) → [inbound fold](../../packages/vault/src/fold/inbound.ts) |
| Back up or recover | [Recovery material](vault-sqlite.md#recovery-material-and-product-requirement) → [export](vault-sqlite.md#snapshot-and-export) → [restore/import](vault-sqlite.md#restore-and-import) → [unfinished receive work](distributed-delivery.md#receive-recovery) |

<a id="rule-ownership"></a>

## Rule ownership

Change the defining section and align its consumers. ES owns event envelopes,
DO owns raw objects/retention APIs and SQ owns SQLite lifecycle. CH owns channel identity,
invitations and the rotation, admission and denial payloads; the continuity
adapter, operation eligibility, admission and dispatch authority are owned by
their code in `packages/vault` and `packages/agent-core`.
The continuity package owns proof verification and graph semantics. VE owns contact selections, display payloads and the remaining
domain payloads, while the folds over them and the procedures that append
them are owned by their code in `packages/vault` and `packages/agent-core`;
DD owns runtime ordering and message/effect identity;
RZ owns the DID profiles, local resolution and address/display policy; the
receive gate, the private-address policy and retry are code.

| Rule | Definition | Consumers |
| --- | --- | --- |
| Event envelope and ordering | [ES](event-store.md#the-event) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary) |
| Commit durability | [ES](event-store.md#commit-and-durability-terminology) | [DD boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Storage ownership and recovery | [SQ](vault-sqlite.md#ownership-and-lifecycle) | [agent open](../../packages/agent-core/src/identity.ts) |
| Object identity and held roots | [DO](dasl-objects.md#accepted-dasl-cids), [VE retention](vault-events.md#held-roots) | [SQ objects](vault-sqlite.md#objects-and-streams) |
| Channel pair and selectors | [CH identity](channels.md#channel-identity) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary), [contact selection](vault-events.md#contact-channelsset) |
| Proof verification, links, joins and query semantics | [Continuity package](../../packages/continuity/README.md) | [channel evidence](../../packages/vault/src/fold/channels.ts), [continuity fold](../../packages/vault/src/fold/continuity.ts) |
| Source projection, admitted confirmation and query policy | [continuity fold](../../packages/vault/src/fold/continuity.ts) | [rotation](../../packages/agent-core/src/rotate.ts), [DD receive](distributed-delivery.md#receive-a-message) |
| New-send head selection | [contact view](../../packages/vault/src/fold/views.ts) | [DD built-in replies](distributed-delivery.md#built-in-independent-operations), [RZ sending](relationships.md#ordinary-sending-and-birth-selection), [rotation](../../packages/agent-core/src/rotate.ts) |
| Deferred-proof adapter boundary | [DIDComm API](../../packages/agent-core/README.md#didcomm-api) | [receive gate](../../packages/agent-core/src/receive/gate.ts), [DD receipt](distributed-delivery.md#receive-a-message), [VE carrier](vault-events.md#message-in) |
| Receipt verification status | [continuity fold](../../packages/vault/src/fold/continuity.ts) | [DD recovery](distributed-delivery.md#receive-recovery) |
| Durable application admission and operation eligibility | [CH](channels.md#application-admission), [admission model](../../packages/vault/src/admission/model.ts) | [inbound fold](../../packages/vault/src/fold/inbound.ts) |
| Fixed intent/package and manual dispatch | [live action](../../packages/agent-core/src/action.ts), [dispatch](../../packages/agent-core/src/dispatch.ts) | [VE intent](vault-events.md#message-out), [package](vault-events.md#message-prepared), [DD send](distributed-delivery.md#send-an-ordinary-message) |
| Inbound/execution IDs | [DD identity](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [inbound fold](../../packages/vault/src/fold/inbound.ts) |
| Content/intent/plaintext normalization | [DD hashes](distributed-delivery.md#canonical-projections-and-hashes), [VE stored content](vault-events.md#stored-message-document) | [VE package](vault-events.md#message-prepared) |
| ACK selection and authorization | [DD ACKs](distributed-delivery.md#durable-end-to-end-acknowledgment) | [VE ACK witness](vault-events.md#delivery-acknowledged) |
| Complete witnesses | [VE witnesses](vault-events.md#complete-observation-witnesses) | [CH links](channels.md#channel-linked), [DD ACKs](distributed-delivery.md#applying-ack) |
| Channel method boundary, local resolution and mediator resolution | [RZ resolution](relationships.md#did-resolution-requirements), [receive gate](../../packages/agent-core/src/receive/gate.ts) | [receipt](../../packages/agent-core/src/receive/receipt.ts), [DD receipt](distributed-delivery.md#receive-a-message) |
| Invitations | [VE disclosure](vault-events.md#did-disclosed), [invitation fold](../../packages/vault/src/fold/invitations.ts) | [CH invitations](channels.md#invitations) |
| Denial and contact views | [CH policy/display](channels.md#effects-and-recovery) | [VE contact selection](vault-events.md#contact-channelsset), [deletion](../../packages/vault/src/procedures.ts), [application views](vault-events.md#application-message-views) |
| Submission/receipt state | [outbound fold](../../packages/vault/src/fold/outbound.ts) | [DD completion](distributed-delivery.md#submission-completion-and-expiration) |
| Restore and import | [SQ interchange](vault-sqlite.md#restore-and-import) | [DD recovery](distributed-delivery.md#receive-recovery) |

<a id="evidence-and-references"></a>

## Evidence and references

The seven documents above are the complete phase-1 contract. No document
lists conformance cases: the tests of the package that implements a
document are its evidence, and the folds and procedures over the vault's
events are specified by their code (see
[vault events section 13](vault-events.md#folds-and-procedures)).
Multi-replica mediation, network vault synchronization and mutable channel
DIDs have only [deferred design notes](deferred/README.md). Those notes
reserve no phase-1 fields, error codes, key names or extension APIs; future
features will define their schemas when adopted.

Named anchors support direct links independently of displayed section numbers.

<a id="editing-conventions"></a>

## Editing conventions

Describe the specified behavior and its constraints directly. Keep a rule with
its owning document, or with its owning module when it is code, and link to
it from consumers. Use stable named anchors for references.
