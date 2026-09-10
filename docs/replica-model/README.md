# Estoc version 3 specification suite

Status: **draft**. Phase 1 has one active writable full vault runtime, six
specifications and two deferred extensions. SQLite is the sole persistent vault
and portable interchange format. This guide is informative; linked specification
sections define requirements.

The implemented version-2 vault is documented separately in
[event-store.md](../event-store.md), [vault-folder.md](../vault-folder.md) and
[vault-events.md](../vault-events.md). Existing version-3 folder code also
predates this SQLite draft and does not establish SQLite conformance. This
revision changes specifications, not the implementation's completion status.

<a id="model-overview"></a>

## Model overview

A vault has one seed and immutable events. Folds derive current state; raw
content-addressed objects hold retained bytes. A relationship keeps its original
address-pair identity while either end rotates. Sending records intent before
network effects; committed submission ends sending work and peer acknowledgment
records receipt. See the [vault model](vault-events.md#model),
[relationship model](relationships.md#what-it-is-for) and
[commit boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage semantics | [Event store](event-store.md), [DASL objects](dasl-objects.md) | API, event identity/order, raw CID/bytes and retention |
| Persistence | [SQLite vault](vault-sqlite.md) | Schema, ownership, transactions, maintenance and portable recovery |
| Application state | [Vault events](vault-events.md) | Payloads, evidence validation, folds and held roots |
| Runtime protocols | [Delivery](distributed-delivery.md), [Relationships](relationships.md) | Send/receive/ACK procedures and address policy |
| Deferred extensions | [Replica mediation](replica-mediation.md), [Vault sync](vault-sync.md) | Future per-replica pickup and encrypted synchronization |

The relationship profile defines no Estoc rendezvous wire handshake.
Public/rendezvous addresses are a discovery concept in that profile.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [relationships](relationships.md#what-it-is-for) → [commit/ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity](dasl-objects.md#reading-guide) → [EventStore/Vault](event-store.md#reading-guide) → [SQLite](vault-sqlite.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas/folds](vault-events.md#reading-guide) → [procedures](vault-events.md#procedures) |
| Implement sending | [Send](distributed-delivery.md#send-an-ordinary-message) → [address selection](relationships.md#ordinary-sending-and-birth-selection) → [package preparation](distributed-delivery.md#preparing-a-package) → [delivery fold](vault-events.md#outbound-message-and-delivery-fold) |
| Implement receiving | [Receive](distributed-delivery.md#receive-a-message) → [resolution](relationships.md#did-resolution-requirements) → [receipt gates](relationships.md#uniform-receipt) → [evidence](vault-events.md#receipt-and-relationship-evidence) → [scope](distributed-delivery.md#address-chains-and-observation-membership) → [inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Back up or recover | [Recovery material](vault-sqlite.md#recovery-material-and-product-requirement) → [export](vault-sqlite.md#snapshot-and-export) → [restore/import](vault-sqlite.md#restore-and-import) → [unfinished receive work](distributed-delivery.md#receive-recovery) |
| Explore future replication | Phase-1 documents first, then [replica mediation](replica-mediation.md#reading-guide) and [vault sync](vault-sync.md#reading-guide) |

<a id="rule-ownership"></a>

## Rule ownership

Change the defining section, not a second copy of its rules. ES describes what
a caller observes; DO defines object identity and retention; SQ alone owns
SQLite procedures. Domain schemas, folds and wire protocols are unchanged.

| Rule | Definition | Connected sections |
| --- | --- | --- |
| Event envelope, IDs and canonical order | [ES §§3–4](event-store.md#the-event) | [VE identifiers](vault-events.md#identifier-and-reference-vocabulary) |
| Process-durable success and commit API | [ES §2.1](event-store.md#commit-and-durability-terminology), [ES §10](event-store.md#vault-interface) | [DD boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| SQLite ownership, transactions and maintenance | [SQ §§6–9](vault-sqlite.md#objects-and-streams) | [VE operation-lock scope](vault-events.md#receipt-and-relationship-evidence) |
| Raw CID identity and object API | [DO §§3–6](dasl-objects.md#accepted-dasl-cids) | [SQ object rows](vault-sqlite.md#objects-and-streams) |
| Export, validation, restore and import | [SQ §§10–12](vault-sqlite.md#snapshot-and-export) | [ES interchange](event-store.md#interchange) |
| Metadata, wrapper and local control | [SQ §4](vault-sqlite.md#identity-and-keystore), [SQ §7](vault-sqlite.md#local-state-and-projections) | [ES typed API](event-store.md#metadata-and-keystore), [VE open](vault-events.md#open-the-writable-full-runtime) |
| Vault-event fields, typed references and folds | [VE](vault-events.md#reading-guide) | [DD procedures](distributed-delivery.md#reading-guide), [RZ policy](relationships.md#reading-guide) |
| Stored message and attachment normalization | [VE §8](vault-events.md#stored-message-document) | [DD hash projections](distributed-delivery.md#canonical-projections-and-hashes) |
| Logical content, intent and plaintext hashes | [DD §5](distributed-delivery.md#canonical-projections-and-hashes) | [VE outbound events](vault-events.md#outbound-message-events) |
| Inbound observation IDs, execution scope and IDs | [DD §9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [VE inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Relationship ID and default allocation IDs | [RZ §5](relationships.md#symmetric-relationship-identity) | [VE binding schema](vault-events.md#relationship-bound) |
| Binding evidence, pending-pair claims and address index | [VE §6.1](vault-events.md#receipt-and-relationship-evidence), [VE §6.6](vault-events.md#relationship-fold-and-address-index) | [RZ deferred delivery](relationships.md#deferred-delivery), [DD scope](distributed-delivery.md#address-chains-and-observation-membership) |
| Peer and local transition evidence | [VE §6.4](vault-events.md#relationship-peertransitioned), [VE §6.5](vault-events.md#relationship-localtransitioned) | [RZ privacy policy](relationships.md#early-private-address-policy-and-notifications), [RZ peer changes](relationships.md#peer-address-changes) |
| Resolution freshness, failures and bounded retry | [RZ §10.1](relationships.md#did-resolution-requirements) | [RZ wait state](relationships.md#deferred-delivery), [DD receive](distributed-delivery.md#receive-a-message), [VE evidence](vault-events.md#message-in), [RM pickup ACK](replica-mediation.md#messages-received) |
| Relationship-evidence wait and retry triggers | [RZ §9.1](relationships.md#deferred-delivery), [RZ accounting](relationships.md#shared-accounting-and-lost-wait-state) | [VE pending-pair evidence](vault-events.md#receipt-and-relationship-evidence) |
| Transport retry interval, backoff and accounting | [RZ §14](relationships.md#retry-replacement-and-address-rollover) | [DD completion](distributed-delivery.md#submission-completion-and-expiration), [DD failures](distributed-delivery.md#failure-rules) |
| Pickup ACK commit and terminal classification | [DD §4.1](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table), [DD §4.3](distributed-delivery.md#receive-a-message), [RZ gates](relationships.md#hard-pre-vault-gate) | [VE receipt](vault-events.md#message-in), [RM scope](replica-mediation.md#messages-received) |
| Peer ACK target selection and freezing | [DD §8.1](distributed-delivery.md#freezing-an-ack-target-set), [VE receipt order](vault-events.md#message-in) | [RZ responses](relationships.md#automatic-response-selection), [VE outbound fold](vault-events.md#outbound-message-and-delivery-fold) |
| Receipt gates and default contact/address policy | [RZ §9](relationships.md#uniform-receipt), [RZ §5.2](relationships.md#binding-and-contact-policy), [RZ §11](relationships.md#early-private-address-policy-and-notifications) | [DD receive](distributed-delivery.md#receive-a-message), [VE contacts](vault-events.md#contact-fold) |
| Send, receive and ACK procedure ordering | [DD §4.2](distributed-delivery.md#send-an-ordinary-message), [DD §8](distributed-delivery.md#durable-end-to-end-acknowledgment), [DD §4.3](distributed-delivery.md#receive-a-message) | [VE schemas/folds](vault-events.md#reading-guide) |
| Complete observation witness matching | [VE §10.5](vault-events.md#complete-observation-witnesses) | [VE peer transition](vault-events.md#relationship-peertransitioned), [VE ACK aggregation](vault-events.md#outbound-message-and-delivery-fold) |
| Submission completion, ACK timing and work eligibility | [VE §9.8](vault-events.md#outbound-message-and-delivery-fold) | [DD completion](distributed-delivery.md#submission-completion-and-expiration), [DD applying ACK](distributed-delivery.md#applying-ack) |
| Prepared-envelope retention and erasure | [VE §12.3](vault-events.md#held-roots) | [DO collection](dasl-objects.md#collection), [VE erase](vault-events.md#erase-a-message) |
| Local open, erase, delete and rotate procedures | [VE §13](vault-events.md#procedures) | [ES Vault](event-store.md#vault-interface), [DD procedures](distributed-delivery.md#reading-guide) |

<a id="conformance-and-references"></a>

## Conformance and references

| Prefix | Cases | Status |
| --- | --- | --- |
| ES | [Event store](event-store.md#required-conformance-cases) | Phase 1 |
| DO | [DASL objects](dasl-objects.md#required-conformance-cases) | Phase 1 |
| SQ | [SQLite vault](vault-sqlite.md#required-conformance-cases) | Phase 1 |
| VE | [Vault events](vault-events.md#required-conformance-cases) | Phase 1 |
| DD | [Distributed delivery](distributed-delivery.md#required-conformance-cases) | Phase 1 |
| RZ | [Relationships and addresses](relationships.md#required-conformance-cases) | Phase 1 |
| RM | [Replica mediation](replica-mediation.md#required-conformance-cases) | Deferred |
| VS | [Vault sync](vault-sync.md#required-conformance-cases) | Deferred |

Named anchors support direct links independently of displayed section numbers.
The relationship profile keeps its historical RZ prefix. Existing cases retain
their subjects; changed draft guarantees are recorded below rather than claimed
to have passed because an older implementation passed earlier tests.

<a id="editing-conventions"></a>

## Editing conventions

Keep named anchors and case identities when editing. Historical aliases such as
`<a id="142-mediation-fold"></a>` preserve earlier links. Record intentional
retirements and moved/retitled numbered sections in the history. Keep procedures
with their owner instead of repeating implementation requirements across files.

<a id="section-history"></a>

## Section history

### SQLite phase-1 simplification

The first SQLite draft at `06fc76d9` is superseded without a migration or version
bump because it is unreleased. The common schema now has CID-keyed objects and
chunks; `object_data`, physical `data_id` versions and `object_acceptance` are
removed. Portable query-performance indexes and a prescribed change-token encoding
are no longer required. The wrapper uses the existing compact JWE string.

Read/maintenance contracts now permit serialization or explicit cancellation,
not compulsory nonblocking writes, indefinitely paused streams, per-CID/version
latches, a cross-process broker or seamless online repair. ES-27/28/30–32 and
SQ-22–27 keep their read/ownership subjects under this relaxed contract; their
old concurrency assertions are not required tests. DO-18/21 and SQ-21/23 no longer
require orphan grace or acceptance clocks. `collect` returns only `removed`;
full `Vault.commit` rejects supplied objects with no draft reference.

Direct folds are sufficient; cache schemas, incremental algorithms and background
rebuild protocols are not requirements. Optional caches still cannot serve stale
answers. Source-only import validation precedes the target lock. Export releases
the operation lock before delivering its completed standalone file. SQLite owns
transaction recovery; application-level blind retry of uncertain new drafts is
not an exactly-once guarantee. Storage section numbers and named anchors remain;
event envelopes, raw CIDs, key derivation, domain folds and wire formats do not
change. Key/object safety, atomic acceptance and complete recovery remain required.

### Folder retirement

The unreleased version-3 `vault-folder.md` was replaced by
[vault-sqlite.md](vault-sqlite.md). Its
[pre-SQLite revision](https://github.com/estoc-net/estoc/blob/4a0dae97975f30f3d6f4a4346ae47f6ae744da26/docs/replica-model/vault-folder.md)
is historical, not another accepted format or migration input. That file's anchors
and VF-1–VF-43 are retired; SQ cases are not aliases. Version-2 documents outside
this directory still describe their historical implementation.

ES §8 is typed metadata/keystore/local state, ES §11.1 is SQLite round trip, and
DO §10 is SQLite representation. Former FileStore/folder anchors are retired.
Folder journals, file merge and byte-position cursors are replaced by SQLite
transactions and local event positions. Portable snapshots contain exactly held
objects and exclude runtime control; ordinary cache clearing preserves identity.
The deferred sync root maps its logical configuration into SQLite metadata.

### Earlier domain reordering

`relationships.md` was previously named `rendezvous.md`; section numbers, named
anchors and RZ cases were preserved. The following tables retain mappings for
earlier reviews. These domain documents are not changed by the simplification.

<details>
<summary>Vault-events section numbers from a720fdf before domain grouping</summary>

| Previous section | Current section | Topic |
| --- | --- | --- |
| 6 | [3.6](vault-events.md#identity-label) | identity.label |
| 7 | [7](vault-events.md#contacts) | Contacts and profiles (retitled) |
| 9 | [9](vault-events.md#outbound-message-events) | Outbound messages and delivery (retitled) |
| 10 | [10](vault-events.md#inbound-message-events) | Inbound messages and execution (retitled) |
| 11 | [4.3](vault-events.md#resolution-observations) | Resolution observations |
| 11.1 | [4.4](vault-events.md#peer-resolved) | peer.resolved |
| 11.2 | [6.4](vault-events.md#relationship-peertransitioned) | relationship.peerTransitioned |
| 11.3 | [7.3](vault-events.md#profile-nameclaimed) | profile.nameClaimed |
| 11.4 | [7.4](vault-events.md#profile-shared) | profile.shared |
| 12 | [6](vault-events.md#relationships-and-address-changes) | Relationships and address changes |
| 12.1 | [6.1](vault-events.md#receipt-and-relationship-evidence) | Receipt and relationship evidence |
| 12.2 | [6.2](vault-events.md#relationship-bound) | relationship.bound |
| 12.3 | [6.3](vault-events.md#relationship-contactassigned) | relationship.contactAssigned |
| 12.4 | [6.5](vault-events.md#relationship-localtransitioned) | relationship.localTransitioned |
| 13 | [11](vault-events.md#automatic-effects) | Automatic effects |
| 14 | [2.1](vault-events.md#folds) | Fold conventions |
| 14.1 | [3.7](vault-events.md#runtime-author-fold) | Runtime-author fold |
| 14.2 | [5.6](vault-events.md#mediation-fold) | Mediation fold |
| 14.3 | [5.7](vault-events.md#route-did-and-key-fold) | Route, DID and key fold |
| 14.4 | [6.6](vault-events.md#relationship-fold-and-address-index) | Relationship fold and address index |
| 14.5 | [7.5](vault-events.md#relationship-profile-fold) | Relationship profile fold |
| 14.6 | [7.6](vault-events.md#contact-fold) | Contact fold |
| 14.7 | [10.6](vault-events.md#inbound-message-and-execution-fold) | Inbound message and execution fold |
| 14.8 | [9.8](vault-events.md#outbound-message-and-delivery-fold) | Outbound message and delivery fold |
| 14.9 | [5.8](vault-events.md#invitation-fold) | Invitation fold |
| 15 | [12](vault-events.md#erasure-and-collection) | Erasure and collection |
| 15.1 | [12.1](vault-events.md#message-erased) | message.erased |
| 15.2 | [12.2](vault-events.md#reading-content) | Reading content |
| 15.3 | [12.3](vault-events.md#held-roots) | Held roots |
| 15.4 | [12.4](vault-events.md#no-runtime-local-eviction-event) | No runtime-local eviction event |
| 16 | [13](vault-events.md#procedures) | Procedures |
| 16.1 | [13.1](vault-events.md#open-the-writable-full-runtime) | Open the writable full runtime |
| 16.2 | [13.2](vault-events.md#establish-mediation) | Establish mediation |
| 16.3 | [13.3](vault-events.md#create-a-communication-did) | Create a communication DID |
| 16.4 | [13.4](vault-events.md#disclose-an-address) | Disclose an address |
| 16.5 | [13.5](vault-events.md#erase-a-message) | Erase a message |
| 16.6 | [13.6](vault-events.md#delete-a-contact) | Delete a contact |
| 16.7 | [13.7](vault-events.md#rotate-a-local-relationship-address) | Rotate a local relationship address |
| 17 | [14](vault-events.md#merge-synchronization-and-restore) | Merge, synchronization and restore |
| 17.1 | [14.1](vault-events.md#event-merge) | Event merge |
| 17.2 | [14.2](vault-events.md#object-merge) | Object merge |
| 17.3 | [14.3](vault-events.md#replica-synchronization-deferred) | Replica synchronization (deferred) |
| 17.4 | [14.4](vault-events.md#restore) | Restore |
| 17.5 | [14.5](vault-events.md#forked-author) | Forked author |
| 18 | [15](vault-events.md#privacy-and-security-boundaries) | Privacy and security boundaries |
| 19 | [16](vault-events.md#versioning) | Versioning |
| 20 | [17](vault-events.md#required-conformance-cases) | Required conformance cases |

</details>

<details>
<summary>Relationships: section numbers from 0958f32 before identity reordering</summary>

| Previous section | Current section | Topic |
| --- | --- | --- |
| 10 | [5](relationships.md#symmetric-relationship-identity) | Symmetric relationship identity |
| 10.1 | [5.1](relationships.md#contact-ids) | Contact IDs |
| 10.2 | [5.2](relationships.md#binding-and-contact-policy) | Binding and contact policy |
| 5 | [10](relationships.md#did-profiles-and-resolution-evidence) | DID profiles and resolution evidence |
| 5.1 | [10.1](relationships.md#did-resolution-requirements) | Common requirements |
| 5.2 | [10.2](relationships.md#peer-did-numalgo-4-profile) | Peer DID numalgo-4 profile |

</details>

<details>
<summary>Distributed delivery: section numbers from 0958f32 before procedure grouping</summary>

| Previous section | Current section | Topic |
| --- | --- | --- |
| 4 | [4](distributed-delivery.md#vault-first-procedures-and-commit-boundaries) | Vault-first procedures and commit boundaries (retitled) |
| 9.1 | [4.3](distributed-delivery.md#receive-a-message) | Receive a message |
| 9.2 | [4.4](distributed-delivery.md#receive-recovery) | Receive recovery |

</details>
