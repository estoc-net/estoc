# Estoc version 3 specification suite

Status: **draft**. Phase 1 has one active writable full vault runtime.
The suite contains six phase-1 specifications and two deferred extensions.
SQLite is the sole persistent vault and portable interchange format.
This page and the reading guides are informative navigation; the linked
specification sections define the requirements.

The implemented version-2 vault is documented separately in
[event-store.md](../event-store.md), [vault-folder.md](../vault-folder.md)
and [vault-events.md](../vault-events.md). Those documents describe the existing
implementation; the version-3 drafts in this directory do not assert that
their features are implemented. Existing version-3 folder code also predates
this SQLite revision and is not evidence of SQLite conformance. Each document
states its own version and status.

<a id="model-overview"></a>

## Model overview

A vault has one seed and records immutable events. Event folds derive current
state, while content-addressed objects hold message bodies and other retained
bytes. A relationship keeps the identity of its original address pair as
either end changes address. Sending records intent before network effects;
committed submission ends sending work, while peer acknowledgment records
receipt information. See the [vault model](vault-events.md#model),
[relationship model](relationships.md#what-it-is-for) and
[commit boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage primitives | [Event store](event-store.md), [DASL objects](dasl-objects.md) | Event envelope, commit, store interfaces, exact object identity and bytes |
| Persistence and interchange | [SQLite vault](vault-sqlite.md) | Single-database storage, atomic publication, portable backup and recovery |
| Portable application state | [Vault events](vault-events.md) | Event payloads, evidence validation, folds and held roots |
| Runtime protocols and policy | [Delivery](distributed-delivery.md), [Relationships and addresses](relationships.md) | Sending, receipt, acknowledgment, relationship formation and address policy |
| Deferred extensions | [Replica mediation](replica-mediation.md), [Vault sync](vault-sync.md) | Future per-replica pickup and encrypted remote synchronization |

The relationship and address policy profile defines no Estoc rendezvous wire
handshake. Public/rendezvous addresses remain a discovery concept in that profile.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [relationship model](relationships.md#what-it-is-for) → [commit and ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity and ObjectStore](dasl-objects.md#reading-guide) → [EventStore and Vault](event-store.md#reading-guide) → [SQLite schema and interchange](vault-sqlite.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas and folds by domain](vault-events.md#reading-guide) → [open and recovery procedures](vault-events.md#procedures) |
| Implement sending | [Send procedure](distributed-delivery.md#send-an-ordinary-message) → [address selection](relationships.md#ordinary-sending-and-birth-selection) → [package preparation](distributed-delivery.md#preparing-a-package) → [delivery fold](vault-events.md#outbound-message-and-delivery-fold) |
| Implement receiving | [Receive procedure](distributed-delivery.md#receive-a-message) → [resolution](relationships.md#did-resolution-requirements) and [receipt gates](relationships.md#uniform-receipt) → [binding evidence](vault-events.md#receipt-and-relationship-evidence) → [scope](distributed-delivery.md#address-chains-and-observation-membership) and [inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Implement backup and recovery | [Recovery material](vault-sqlite.md#recovery-material-and-product-requirement) → [snapshot and export](vault-sqlite.md#snapshot-and-export) → [restore and import](vault-sqlite.md#restore-and-import) → [unfinished receive work](distributed-delivery.md#receive-recovery) |
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
| Raw CID identity and ObjectStore | [DO §§3–6](dasl-objects.md#accepted-dasl-cids) | [SQ object rows and streams](vault-sqlite.md#objects-and-streams), [ES object interface](event-store.md#objectstore) |
| SQLite schema, export, import and restore | [SQ](vault-sqlite.md#reading-guide) | [ES interchange contract](event-store.md#interchange) |
| Metadata, wrapper and local control | [SQ identity](vault-sqlite.md#identity-and-keystore), [SQ local state](vault-sqlite.md#local-state-and-projections) | [ES typed API](event-store.md#metadata-and-keystore), [VE open](vault-events.md#open-the-writable-full-runtime) |
| Vault-event fields, typed references and folds | [VE](vault-events.md#reading-guide) | [DD wire procedures](distributed-delivery.md#reading-guide), [RZ address policy](relationships.md#reading-guide) |
| Stored message and attachment normalization | [VE §8](vault-events.md#stored-message-document) | [DD hash projections](distributed-delivery.md#canonical-projections-and-hashes) |
| Logical content, intent and plaintext hashes | [DD §5](distributed-delivery.md#canonical-projections-and-hashes) | [VE outbound events](vault-events.md#outbound-message-events) |
| Inbound observation IDs, execution scope and execution IDs | [DD §9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [VE inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Relationship ID and default allocation IDs | [RZ §5](relationships.md#symmetric-relationship-identity) | [VE binding schema](vault-events.md#relationship-bound) |
| Binding evidence, pending-pair claims and address index | [VE §6.1](vault-events.md#receipt-and-relationship-evidence), [VE §6.6](vault-events.md#relationship-fold-and-address-index) | [RZ deferred delivery](relationships.md#deferred-delivery), [DD scope validation](distributed-delivery.md#address-chains-and-observation-membership) |
| Peer and local transition evidence | [VE §6.4](vault-events.md#relationship-peertransitioned), [VE §6.5](vault-events.md#relationship-localtransitioned) | [RZ early-privacy policy](relationships.md#early-private-address-policy-and-notifications), [RZ peer changes](relationships.md#peer-address-changes) |
| Resolution freshness, failures and bounded retry | [RZ §10.1](relationships.md#did-resolution-requirements) | [RZ local wait state](relationships.md#deferred-delivery), [DD receive procedure](distributed-delivery.md#receive-a-message), [VE receipt evidence](vault-events.md#message-in), [RM pickup ACK](replica-mediation.md#messages-received) |
| Relationship-evidence wait and retry triggers | [RZ §9.1](relationships.md#deferred-delivery); resolution accounting in [RZ §10.1](relationships.md#shared-accounting-and-lost-wait-state) | [VE pending-pair evidence](vault-events.md#receipt-and-relationship-evidence) |
| Local transport retry interval, backoff and attempt accounting | [RZ §14](relationships.md#retry-replacement-and-address-rollover) | [DD completion and scheduling](distributed-delivery.md#submission-completion-and-expiration), [DD crash outcomes](distributed-delivery.md#failure-rules) |
| Pickup ACK commit boundary and terminal classification | [DD §4.1](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table), [DD §4.3](distributed-delivery.md#receive-a-message); terminal gates in [RZ §§9.2](relationships.md#hard-pre-vault-gate)–[9.3](relationships.md#integrity-checks-and-durable-receipt) | [VE receipt schema](vault-events.md#message-in), [RM replica/delivery scope](replica-mediation.md#messages-received) |
| Peer ACK target selection and freezing | [DD §8.1](distributed-delivery.md#freezing-an-ack-target-set); receipt-order key in [VE §10.2](vault-events.md#message-in) | [RZ notification policy](relationships.md#automatic-response-selection), [VE outbound membership and receipt fold](vault-events.md#outbound-message-and-delivery-fold) |
| Receipt gates and default contact/address policy | [RZ §9](relationships.md#uniform-receipt), [RZ §5.2](relationships.md#binding-and-contact-policy), [RZ §11](relationships.md#early-private-address-policy-and-notifications) | [DD receipt ordering](distributed-delivery.md#receive-a-message), [VE contact fold](vault-events.md#contact-fold) |
| Send, receive and ACK procedure ordering | [DD §4.2](distributed-delivery.md#send-an-ordinary-message), [DD §8](distributed-delivery.md#durable-end-to-end-acknowledgment), [DD §4.3](distributed-delivery.md#receive-a-message) | [VE schemas and folds](vault-events.md#reading-guide) |
| Complete observation witness matching | [VE §10.5](vault-events.md#complete-observation-witnesses) | [VE peer-transition evidence](vault-events.md#relationship-peertransitioned), [VE ACK aggregation](vault-events.md#outbound-message-and-delivery-fold) |
| Submission completion, ACK receipt timing and outbound work eligibility | [VE §9.8](vault-events.md#outbound-message-and-delivery-fold) | [DD completion](distributed-delivery.md#submission-completion-and-expiration), [DD applying ACK](distributed-delivery.md#applying-ack) |
| Prepared-envelope retention and erasure | [VE §12.3](vault-events.md#held-roots) | [DO collection](dasl-objects.md#collection), [VE erase procedure](vault-events.md#erase-a-message) |
| Local runtime open, erase, delete and rotate procedures | [VE §13](vault-events.md#procedures) | [ES Vault interface](event-store.md#vault-interface), [DD delivery procedures](distributed-delivery.md#reading-guide) |

<a id="conformance-and-references"></a>

## Conformance and references

Each specification ends with required conformance cases grouped by topic.
Existing case identities are retained where the contract continues; the retired
folder cases are replaced as described in the section history. A prefix identifies
the document, so
[RZ-42](relationships.md#rz-42) is case 42 in the relationship profile, and
[VE-129](vault-events.md#ve-129) is vault-events case 129.
The relationship profile retains its historical `RZ` prefix for section
shorthand and case IDs so existing review references still identify the same rules.

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

Named section anchors support direct links without depending on a heading's
displayed number. The section history below maps earlier numbered review
references to their current locations. Code examples and derivation vectors
live with their defining rule.

<a id="editing-conventions"></a>

## Editing conventions

Keep named anchors and case identities when editing or reordering text.
Compatibility anchors such as `<a id="142-mediation-fold"></a>` preserve links
made from earlier numbered headings. Keep these aliases during routine edits;
removing them requires a documented breaking change to historical references.
Record moved and retitled numbered sections in the section history.

<a id="section-history"></a>

## Section history

The unreleased version-3 `vault-folder.md` has been replaced by
[vault-sqlite.md](vault-sqlite.md). The earlier folder specification is available
in [the pre-SQLite revision](https://github.com/estoc-net/estoc/blob/4a0dae97975f30f3d6f4a4346ae47f6ae744da26/docs/replica-model/vault-folder.md).
It is historical documentation, not an accepted format, migration input or
second backend. Version-2 documents outside this directory still describe their
historical implementation.

This intentionally retires that file's named anchors and `VF-1`–`VF-43` cases;
`SQ` cases have new identities and are not aliases. Existing `ES`/`DO` case
numbers continue to identify their semantic subjects, with atomicity, reader
ownership and interchange assertions updated to the SQLite contract. Passing
old folder tests does not establish the revised conformance.

| Previous contract | Current definition |
| --- | --- |
| Folder layout, JSONL segments, path diagnostics and change tokens | [SQLite schema](vault-sqlite.md#common-schema), [events and tokens](vault-sqlite.md#events-and-change-tokens); physical folder cases retired |
| Config and keystore files, arbitrary `FileStore` | [Typed metadata and keystore](event-store.md#metadata-and-keystore), [identity and wrapper rows](vault-sqlite.md#identity-and-keystore); opaque-file API retired |
| Object files, acceptance stamps and unlink | [Object rows, streams and collection](vault-sqlite.md#objects-and-streams); `ObjectStore.collect` reports `removed` instead of `unlinked` |
| Object acceptance before an independently published event batch | [Atomic vault commit](vault-sqlite.md#atomic-vault-commit); rollback accepts neither new objects nor events |
| Folder import journal and incomplete in-place union recovery | [Atomic SQLite import](vault-sqlite.md#import); private staging may be discarded, accepted union is always whole |
| Shared independent live readers | [One owner and brokered reads](vault-sqlite.md#ownership-and-lifecycle); standalone inspection takes exclusive ownership |
| Folder snapshot and database-to-folder round trip | [Fresh portable SQLite](vault-sqlite.md#snapshot-and-export); exactly held objects, no runtime control or deleted-page residue |
| Deleting `local/` to reset identity | [Explicit identity reset](vault-sqlite.md#local-state-and-projections); ordinary cache clearing preserves both IDs |

Event-store section 8 is now metadata/keystore/local state, section 11.1 is the
SQLite round trip, and DASL-object section 10 is SQLite representation. Their
former folder/FileStore anchors are intentionally retired. Event envelopes,
raw CIDs, key derivations, domain folds and encrypted wire formats are unchanged;
the deferred sync root maps its logical configuration into SQLite metadata.


`relationships.md` was previously named `rendezvous.md`. The filename change
preserves its section numbers, named anchors and `RZ` case IDs. Earlier reviews
use the filename that existed at the commit they reviewed.

The vault-events domain reordering retains every named anchor and conformance
case ID. This table maps section numbers from commit `a720fdf` to the current
locations; numbers not listed are unchanged. Retitled chapters with unchanged
numbers are also listed. Event schemas and folds remain
in `vault-events.md`, and runtime procedures remain together in that file.

<details>
<summary>Vault-events section numbers before and after domain grouping</summary>

| Previous section | Current section | Topic |
| --- | --- | --- |
| 6 | [3.6](vault-events.md#identity-label) | identity.label |
| 7 | [7](vault-events.md#contacts) | Contacts → Contacts and profiles (retitled) |
| 9 | [9](vault-events.md#outbound-message-events) | Outbound message events → Outbound messages and delivery (retitled) |
| 10 | [10](vault-events.md#inbound-message-events) | Inbound message events → Inbound messages and execution (retitled) |
| 11 | [4.3](vault-events.md#resolution-observations) | Resolution observations (previously Peer and profile observations) |
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

The relationship identity and delivery receive procedures were moved after
commit `0958f32`. The tables below map that commit's sections to their current
locations; all other numbers are unchanged. Named anchors, earlier numbered
heading aliases and conformance case IDs are retained.

<details>
<summary>Relationships: identity before discovery and detailed resolution</summary>

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
<summary>Distributed delivery: send, receive and recovery together</summary>

| Previous section | Current section | Topic |
| --- | --- | --- |
| 4 | [4](distributed-delivery.md#vault-first-procedures-and-commit-boundaries) | Vault-first sending and commit boundaries → Vault-first procedures and commit boundaries (retitled) |
| 9.1 | [4.3](distributed-delivery.md#receive-a-message) | Receive a message |
| 9.2 | [4.4](distributed-delivery.md#receive-recovery) | Receive recovery |

</details>
