# Estoc version 3 specification suite

Status: **draft**. Phase 1 has one active writable full vault runtime, seven
specifications and two deferred extensions. SQLite is the sole persistent vault
and portable interchange format. This guide is informative; linked specification
sections define requirements.

<a id="model-overview"></a>

## Model overview

A vault has one seed, immutable events and raw content-addressed objects.
Channels are ordered local/peer DID pairs that retain authenticated communication.
Each receipt, package and proof retains its own document evidence. Sending,
automatic output, preparation, local rotation, profile lifts and received ACK/error
attribution use their concrete evidence and applicable policy. A separate
`invitation.consumed` records the peer using a one-use OOB disclosure; it does
not authorize or prevent those operations. Automatic consumption follows the
disclosure's `autoConsume` choice; many-use invitations have no exclusive consumer.
Method-authorized document updates preserve the channel. Directed links are
derived from received proofs and local rotation decisions. Receipt can precede
proof verification, with pending/invalid/conflict status visible in the UI.
Contacts directly select channels for display without cryptographic authority.

An outbound fixes its channel and direction at intent commit. Rotation selects
new messages only. Every transport call follows a durable attempt and a live
initial/manual action; reopen, restore and another replica never automatically
send pending messages or old protocol effects. Manual retry uses the exact
attempted package, while a new channel means a new message ID. Peer ACKs record
receipt independently of submission. See [channels](channels.md#model) and
[delivery boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

Each operation checks its source, endpoint and proof evidence and applicable policy.
Automatic intents and profile results retain their exact source references.
Local rotation decisions freeze the old local DID, peer DID, successor, proof
and nullable trigger.
ACK, Trust Ping reply and rotation notification use independent persisted
intents identified by `(executionId, effectType)`, with at most one compatible
intent per tuple. Each effect type is a stable operation URI. ACKs and rotation
notifications are standalone Empty messages. A notification names its rotation
decision and reuses the original source, successor and proof. Pending work is
derived from retained intents and remains available for manual action.

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage | [Event store](event-store.md), [DASL objects](dasl-objects.md) | Event API, identity/order, object bytes and retention |
| Persistence | [SQLite vault](vault-sqlite.md) | Schema, exclusive ownership, transactions and portable recovery |
| Domain facts | [Vault events](vault-events.md) | Message, attempt, profile and local policy payloads/folds |
| Communication authority | [Channels](channels.md), [Address/contact policy](relationships.md) | Fixed DID pairs, operation evidence, directed continuity, contact selections |
| Runtime | [Delivery](distributed-delivery.md) | Channel-local identity, ACK paths, fixed packaging and live dispatch actions |
| Deferred extensions | [Replica mediation](replica-mediation.md), [Vault sync](vault-sync.md) | Receipt fan-out and encrypted data synchronization, without outbox takeover |

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
| Explore future replication | Phase-1 documents first, then [replica mediation](replica-mediation.md#reading-guide) and [vault sync](vault-sync.md#reading-guide) |

<a id="rule-ownership"></a>

## Rule ownership

Change the defining section and align its consumers. ES owns event envelopes,
DO owns raw objects/retention APIs and SQ owns SQLite lifecycle. CH owns channels,
invitation/proof/rotation/denial/display events, the continuity fold and dispatch authority. VE owns
the remaining domain payloads/folds; DD owns runtime ordering and message/effect
identity; RZ owns DID resolution and address/display policy.

| Rule | Definition | Consumers |
| --- | --- | --- |
| Event envelope and ordering | [ES](event-store.md#the-event) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary) |
| Commit durability | [ES](event-store.md#commit-and-durability-terminology) | [DD boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Storage ownership and recovery | [SQ](vault-sqlite.md#ownership-and-lifecycle) | [VE open](vault-events.md#open-the-writable-full-runtime) |
| Object identity and held roots | [DO](dasl-objects.md#accepted-dasl-cids), [VE retention](vault-events.md#held-roots) | [SQ objects](vault-sqlite.md#objects-and-streams) |
| Channel pair and selectors | [CH identity](channels.md#channel-identity) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary), [contact selection](vault-events.md#contact-channelsset) |
| Proof evidence, derived links and joins | [CH continuity](channels.md#continuity) | [RZ rotation](relationships.md#peer-address-changes) |
| Receipt verification status | [CH status](channels.md#verification-status) | [DD recovery](distributed-delivery.md#receive-recovery) |
| Operation eligibility | [CH](channels.md#operation-eligibility) | [VE input fold](vault-events.md#inbound-message-and-execution-fold) |
| Fixed intent and manual dispatch | [CH](channels.md#fixed-outbound-channel) | [VE intent](vault-events.md#message-out), [attempt](vault-events.md#delivery-attempted), [DD send](distributed-delivery.md#send-an-ordinary-message) |
| Inbound/execution IDs | [DD identity](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [VE execution](vault-events.md#inbound-message-and-execution-fold) |
| Content/intent/plaintext normalization | [DD hashes](distributed-delivery.md#canonical-projections-and-hashes), [VE stored content](vault-events.md#stored-message-document) | [VE package](vault-events.md#message-prepared) |
| ACK selection and authorization | [DD ACKs](distributed-delivery.md#durable-end-to-end-acknowledgment) | [VE ACK witness](vault-events.md#delivery-acknowledged) |
| Complete witnesses | [VE witnesses](vault-events.md#complete-observation-witnesses) | [CH links](channels.md#channel-linked), [DD ACKs](distributed-delivery.md#applying-ack) |
| Resolution, cryptographic gate and budgets | [RZ resolution](relationships.md#did-resolution-requirements), [gate](relationships.md#hard-pre-vault-gate) | [CH receipt](channels.md#receipt), [RM pickup](replica-mediation.md#messages-received) |
| Invitations | [CH consumption](channels.md#invitation-consumed), [VE invitation fold](vault-events.md#invitation-fold) | [VE disclosure](vault-events.md#did-disclosed) |
| Denial and contact views | [CH policy/display](channels.md#effects-and-recovery) | [VE contact selection](vault-events.md#contact-channelsset), [deletion](vault-events.md#delete-a-contact), [profiles](vault-events.md#relationship-profile-fold) |
| Submission/receipt state | [VE delivery fold](vault-events.md#outbound-message-and-delivery-fold) | [DD completion](distributed-delivery.md#submission-completion-and-expiration) |
| Restore and import | [SQ interchange](vault-sqlite.md#restore-and-import) | [DD recovery](distributed-delivery.md#receive-recovery), [VS recovery](vault-sync.md#bootstrap-and-recovery) |

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
| RM | [Replica mediation](replica-mediation.md#required-conformance-cases) | Deferred |
| VS | [Vault sync](vault-sync.md#required-conformance-cases) | Deferred |

Named anchors support direct links independently of displayed section numbers.
Conformance case IDs identify the requirements each implementation must verify.

<a id="editing-conventions"></a>

## Editing conventions

Describe the specified behavior and its constraints directly. Keep procedures
with their owning document and link to them from consumers. Use stable named
anchors and conformance case IDs for references.
