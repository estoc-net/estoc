# Estoc version 3 specification suite

Status: **implemented baseline with pending specification changes**. Durable application
admission and strict rotation restrictions are not yet implemented; see
[conformance status](conformance-status.md#rotation-admission-revision).
Phase 1 has one active writable full vault runtime, seven
specifications. SQLite is the sole persistent vault and portable interchange
format. This guide is informative; linked specification sections define requirements.

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

Operations use their own evidence and policy. One-use OOB consumption is
recorded automatically, including on recovery, and is independent of other
operations; many-use invitations have no exclusive consumer. Contacts organize
selected channels with local names and preferences. Applications derive ordinary display
data only from durably admitted message history under their protocol rules.
Authenticated receipt and application admission are separate facts; ignored
old-peer observations remain available as explicitly labelled diagnostics.

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
| Domain facts | [Vault events](vault-events.md) | Message, delivery, contact and local policy payloads/folds |
| Communication authority | [Channels](channels.md), [Address/contact policy](relationships.md) | Fixed DID pairs, operation evidence, directed continuity, contact selections |
| Runtime | [Delivery](distributed-delivery.md) | Channel-local identity, ACK paths, fixed packaging and live dispatch actions |

Ordinary DIDComm messages need no Estoc wire handshake or contact ID.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [channels and continuity](channels.md#model) → [address/contact policy](relationships.md#what-it-is-for) → [commit/ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity](dasl-objects.md#reading-guide) → [EventStore/Vault](event-store.md#reading-guide) → [SQLite](vault-sqlite.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas/folds](vault-events.md#reading-guide) → [procedures](vault-events.md#procedures) |
| Implement sending | [Send](distributed-delivery.md#send-an-ordinary-message) → [address selection](relationships.md#ordinary-sending-and-birth-selection) → [package preparation](distributed-delivery.md#preparing-a-package) → [delivery fold](vault-events.md#outbound-message-and-delivery-fold) |
| Implement receiving | [Receive](distributed-delivery.md#receive-a-message) → [resolution](relationships.md#did-resolution-requirements) → [receipt gates](relationships.md#uniform-receipt) → [evidence](vault-events.md#receipt-and-relationship-evidence) → [source evidence](distributed-delivery.md#address-chains-and-observation-membership) → [inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Back up or recover | [Recovery material](vault-sqlite.md#recovery-material-and-product-requirement) → [export](vault-sqlite.md#snapshot-and-export) → [restore/import](vault-sqlite.md#restore-and-import) → [unfinished receive work](distributed-delivery.md#receive-recovery) |

<a id="rule-ownership"></a>

## Rule ownership

Change the defining section and align its consumers. ES owns event envelopes,
DO owns raw objects/retention APIs and SQ owns SQLite lifecycle. CH owns channels,
invitation/rotation/denial events, proof verification, the continuity fold and dispatch
authority. VE owns contact selections, display payloads and the remaining
domain payloads/folds; DD owns runtime ordering and message/effect identity;
RZ owns DID resolution and address/display policy.

| Rule | Definition | Consumers |
| --- | --- | --- |
| Event envelope and ordering | [ES](event-store.md#the-event) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary) |
| Commit durability | [ES](event-store.md#commit-and-durability-terminology) | [DD boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Storage ownership and recovery | [SQ](vault-sqlite.md#ownership-and-lifecycle) | [VE open](vault-events.md#open-the-writable-full-runtime) |
| Object identity and held roots | [DO](dasl-objects.md#accepted-dasl-cids), [VE retention](vault-events.md#held-roots) | [SQ objects](vault-sqlite.md#objects-and-streams) |
| Channel pair and selectors | [CH identity](channels.md#channel-identity) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary), [contact selection](vault-events.md#contact-channelsset) |
| Proof evidence, derived links and joins | [CH continuity](channels.md#continuity) | [RZ rotation](relationships.md#peer-address-changes) |
| New-send head selection | [CH](channels.md#fixed-outbound-channel) | [VE contact fold](vault-events.md#contact-fold), [DD built-in replies](distributed-delivery.md#built-in-independent-operations), [RZ sending](relationships.md#ordinary-sending-and-birth-selection), [VE rotation](vault-events.md#rotate-a-local-relationship-address) |
| Deferred-proof adapter boundary | [CH](channels.md#carried-proof-and-library-boundary) | [RZ wait/gate](relationships.md#uniform-receipt), [DD receipt](distributed-delivery.md#receive-a-message), [VE carrier](vault-events.md#message-in) |
| Receipt verification status | [CH status](channels.md#verification-status) | [DD recovery](distributed-delivery.md#receive-recovery) |
| Durable application admission and operation eligibility | [CH](channels.md#application-admission) | [VE input fold](vault-events.md#inbound-message-and-execution-fold) |
| Fixed intent/package and manual dispatch | [CH](channels.md#fixed-outbound-channel) | [VE intent](vault-events.md#message-out), [package](vault-events.md#message-prepared), [DD send](distributed-delivery.md#send-an-ordinary-message) |
| Inbound/execution IDs | [DD identity](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [VE execution](vault-events.md#inbound-message-and-execution-fold) |
| Content/intent/plaintext normalization | [DD hashes](distributed-delivery.md#canonical-projections-and-hashes), [VE stored content](vault-events.md#stored-message-document) | [VE package](vault-events.md#message-prepared) |
| ACK selection and authorization | [DD ACKs](distributed-delivery.md#durable-end-to-end-acknowledgment) | [VE ACK witness](vault-events.md#delivery-acknowledged) |
| Complete witnesses | [VE witnesses](vault-events.md#complete-observation-witnesses) | [CH links](channels.md#channel-linked), [DD ACKs](distributed-delivery.md#applying-ack) |
| Channel method boundary, local resolution and mediator resolution | [RZ resolution](relationships.md#did-resolution-requirements), [gate](relationships.md#hard-pre-vault-gate) | [CH receipt](channels.md#receipt), [DD receipt](distributed-delivery.md#receive-a-message) |
| Invitations | [CH consumption](channels.md#invitation-consumed), [VE invitation fold](vault-events.md#invitation-fold) | [VE disclosure](vault-events.md#did-disclosed) |
| Denial and contact views | [CH policy/display](channels.md#effects-and-recovery) | [VE contact selection](vault-events.md#contact-channelsset), [deletion](vault-events.md#delete-a-contact), [application views](vault-events.md#application-message-views) |
| Submission/receipt state | [VE delivery fold](vault-events.md#outbound-message-and-delivery-fold) | [DD completion](distributed-delivery.md#submission-completion-and-expiration) |
| Restore and import | [SQ interchange](vault-sqlite.md#restore-and-import) | [DD recovery](distributed-delivery.md#receive-recovery) |

<a id="conformance-and-references"></a>

## Conformance and references

| Prefix | Cases | Status |
| --- | --- | --- |
| ES | [Event store](event-store.md#required-conformance-cases) | Phase 1 |
| DO | [DASL objects](dasl-objects.md#required-conformance-cases) | Phase 1 |
| SQ | [SQLite vault](vault-sqlite.md#required-conformance-cases) | Phase 1 |
| VE | [Vault events](vault-events.md#required-conformance-cases) | Phase 1 |
| DD | [Distributed delivery](distributed-delivery.md#required-conformance-cases) | Phase 1 |
| CH | [Channels and continuity](channels.md#required-conformance-cases) | Phase 1 |
| RZ | [Channel address and contact policy](relationships.md#required-conformance-cases) | Phase 1 |

[Conformance status](conformance-status.md) reports, case by case, the code and
tests behind each of them in this repository.

The seven documents above are the complete phase-1 contract. Multi-replica
mediation, network vault synchronization and mutable channel DIDs have only
[deferred design notes](deferred/README.md). Those notes reserve no phase-1
fields, error codes, key names, extension APIs or conformance requirements.
Future features will define their schemas and conformance requirements when adopted.

Named anchors support direct links independently of displayed section numbers.
Conformance case IDs identify the requirements each implementation must verify.
Removed cases leave gaps; remaining IDs are stable and are not renumbered or reused.

<a id="editing-conventions"></a>

## Editing conventions

Describe the specified behavior and its constraints directly. Keep procedures
with their owning document and link to them from consumers. Use stable named
anchors and conformance case IDs for references.
