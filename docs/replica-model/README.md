# Estoc version 3 specification suite

Status: **draft**. Phase 1 has one active writable full vault runtime.
The suite contains six phase-1 specifications and two deferred extensions.
This page and the reading guides are informative navigation; the linked
specification sections define the requirements.

The implemented version-2 vault is documented separately in
[event-store.md](../event-store.md), [vault-folder.md](../vault-folder.md)
and [vault-events.md](../vault-events.md). Those documents describe the existing
implementation; the version-3 drafts in this directory do not assert that
their features are implemented. Each document states its own version and status.

<a id="model-overview"></a>

## Model overview

A vault has one seed and records immutable events. Event folds derive current
state, while content-addressed objects hold message bodies and other retained
bytes. A relationship keeps the identity of its original address pair as
either end changes address. Sending records intent before network effects;
committed submission ends sending work, while peer acknowledgment records
receipt information. See the [vault model](vault-events.md#model),
[relationship model](rendezvous.md#what-it-is-for) and
[commit boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage primitives | [Event store](event-store.md), [DASL objects](dasl-objects.md) | Event envelope, commit, store interfaces, exact object identity and bytes |
| File representation | [Vault folder](vault-folder.md) | Reference folder backend, readable interchange and backup |
| Portable application state | [Vault events](vault-events.md) | Event payloads, evidence validation, folds and held roots |
| Runtime protocols and policy | [Delivery](distributed-delivery.md), [Relationships and addresses](rendezvous.md) | Sending, receipt, acknowledgment, relationship formation and address policy |
| Deferred extensions | [Replica mediation](replica-mediation.md), [Vault sync](vault-sync.md) | Future per-replica pickup and encrypted remote synchronization |

The historical filename `rendezvous.md` now covers the relationship and address
policy profile. It defines no Estoc rendezvous wire handshake.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [relationship model](rendezvous.md#what-it-is-for) → [commit and ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity and ObjectStore](dasl-objects.md#reading-guide) → [EventStore and Vault](event-store.md#reading-guide) → [folder backend and interchange](vault-folder.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas and folds by domain](vault-events.md#reading-guide) → [open and recovery procedures](vault-events.md#procedures) |
| Implement sending | [Send procedure](distributed-delivery.md#send-an-ordinary-message) → [address selection](rendezvous.md#ordinary-sending-and-birth-selection) → [package preparation](distributed-delivery.md#preparing-a-package) → [delivery fold](vault-events.md#outbound-message-and-delivery-fold) |
| Implement receiving | [Receive procedure](distributed-delivery.md#receive-a-message) → [resolution](rendezvous.md#did-resolution-requirements) and [receipt gates](rendezvous.md#uniform-receipt) → [binding evidence](vault-events.md#receipt-and-relationship-evidence) → [scope](distributed-delivery.md#address-chains-and-observation-membership) and [inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Implement backup and recovery | [Recovery material](vault-folder.md#recovery-material-and-product-requirement) → [snapshot and export](vault-folder.md#snapshot-and-export) → [import and restore](vault-folder.md#import-and-restore) → [unfinished receive work](distributed-delivery.md#receive-recovery) |
| Explore future replication | Read the phase-1 documents first, then [replica mediation](replica-mediation.md#reading-guide) and [vault sync](vault-sync.md#reading-guide). Neither extension is required for phase 1. |

<a id="rule-ownership"></a>

## Rule ownership

Use the definition column when changing a rule. The connected sections show
where the rule is consumed or applied; they do not create a second definition.
This index records the existing division of responsibilities.

| Rule | Definition | Connected sections |
| --- | --- | --- |
| Event envelope, event IDs and canonical order | [ES §§3–4](event-store.md#the-event) | [VE identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) |
| Process durability, writer lock and commit | [ES §2.1](event-store.md#commit-and-durability-terminology), [ES §10](event-store.md#vault-interface) | [DD commit boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table), [VE receive-lock scope](vault-events.md#receipt-and-relationship-evidence) |
| Raw CID identity and ObjectStore | [DO §§3–6](dasl-objects.md#accepted-dasl-cids) | [VF object paths](vault-folder.md#dasl-object-paths), [ES object interface](event-store.md#objectstore) |
| Folder bytes, import and restore | [VF](vault-folder.md#reading-guide) | [ES interchange contract](event-store.md#interchange) |
| Vault-event fields, typed references and folds | [VE](vault-events.md#reading-guide) | [DD wire procedures](distributed-delivery.md#reading-guide), [RZ address policy](rendezvous.md#reading-guide) |
| Stored message and attachment normalization | [VE §8](vault-events.md#stored-message-document) | [DD hash projections](distributed-delivery.md#canonical-projections-and-hashes) |
| Logical content, intent and plaintext hashes | [DD §5](distributed-delivery.md#canonical-projections-and-hashes) | [VE outbound events](vault-events.md#outbound-message-events) |
| Inbound observation IDs, execution scope and execution IDs | [DD §9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [VE inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Relationship ID and default allocation IDs | [RZ §10](rendezvous.md#symmetric-relationship-identity) | [VE binding schema](vault-events.md#relationship-bound) |
| Binding evidence, pending-pair claims and address index | [VE §12.1](vault-events.md#receipt-and-relationship-evidence), [VE §14.4](vault-events.md#relationship-fold-and-address-index) | [RZ deferred delivery](rendezvous.md#deferred-delivery), [DD scope validation](distributed-delivery.md#address-chains-and-observation-membership) |
| Peer and local transition evidence | [VE §11.2](vault-events.md#relationship-peertransitioned), [VE §12.4](vault-events.md#relationship-localtransitioned) | [RZ early-privacy policy](rendezvous.md#early-private-address-policy-and-notifications), [RZ peer changes](rendezvous.md#peer-address-changes) |
| Resolution freshness, failures and bounded retry | [RZ §5.1](rendezvous.md#did-resolution-requirements) | [RZ local wait state](rendezvous.md#deferred-delivery), [DD receive procedure](distributed-delivery.md#receive-a-message) |
| Receipt gates and default contact/address policy | [RZ §9](rendezvous.md#uniform-receipt), [RZ §10.2](rendezvous.md#binding-and-contact-policy), [RZ §11](rendezvous.md#early-private-address-policy-and-notifications) | [DD receipt ordering](distributed-delivery.md#receive-a-message), [VE contact fold](vault-events.md#contact-fold) |
| Send, receive and ACK procedure ordering | [DD §4.2](distributed-delivery.md#send-an-ordinary-message), [DD §8](distributed-delivery.md#durable-end-to-end-acknowledgment), [DD §9.1](distributed-delivery.md#receive-a-message) | [VE schemas and folds](vault-events.md#reading-guide) |
| Complete observation witness matching | [VE §10.5](vault-events.md#complete-observation-witnesses) | [VE peer-transition evidence](vault-events.md#relationship-peertransitioned), [VE ACK aggregation](vault-events.md#outbound-message-and-delivery-fold) |
| Submission completion, ACK receipt timing and outbound work eligibility | [VE §14.8](vault-events.md#outbound-message-and-delivery-fold) | [DD completion](distributed-delivery.md#submission-completion-and-expiration), [DD applying ACK](distributed-delivery.md#applying-ack) |
| Prepared-envelope retention and erasure | [VE §15.3](vault-events.md#held-roots) | [DO collection](dasl-objects.md#collection), [VE erase procedure](vault-events.md#erase-a-message) |
| Local runtime open, erase, delete and rotate procedures | [VE §16](vault-events.md#procedures) | [ES Vault interface](event-store.md#vault-interface), [DD delivery procedures](distributed-delivery.md#reading-guide) |

<a id="conformance-and-references"></a>

## Conformance and references

Each specification ends with required conformance cases grouped by topic.
Existing case numbers are retained. A prefix identifies the document, so
[RZ-42](rendezvous.md#rz-42) is the existing rendezvous case 42, and
[VE-129](vault-events.md#ve-129) is vault-events case 129.

| Prefix | Cases | Status |
| --- | --- | --- |
| ES | [Event store](event-store.md#required-conformance-cases) | Phase 1 |
| DO | [DASL objects](dasl-objects.md#required-conformance-cases) | Phase 1 |
| VF | [Vault folder](vault-folder.md#required-conformance-cases) | Phase 1 |
| VE | [Vault events](vault-events.md#required-conformance-cases) | Phase 1 |
| DD | [Distributed delivery](distributed-delivery.md#required-conformance-cases) | Phase 1 |
| RZ | [Relationships and addresses](rendezvous.md#required-conformance-cases) | Phase 1 |
| RM | [Replica mediation](replica-mediation.md#required-conformance-cases) | Deferred |
| VS | [Vault sync](vault-sync.md#required-conformance-cases) | Deferred |

Named section anchors support direct links without depending on a heading's
displayed number. Keep those anchors and case identities when editing or
reordering text. The original numbered sections remain available for review
references. Code examples and derivation vectors live with their defining rule.
