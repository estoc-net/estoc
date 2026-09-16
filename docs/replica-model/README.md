# Estoc version 3 specification suite

Status: **draft**. Phase 1 has one active writable full vault runtime, seven
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

A vault has one seed, immutable events and raw content-addressed objects.
Fixed DID-pair channels retain authenticated communication. Local acceptance
pins exact peer evidence; directed links record one endpoint replacement.
Relationship/contact groups organize display without cryptographic authority.

An outbound fixes its channel and direction at intent commit. Rotation selects
new messages only. Every transport call follows a durable attempt and a live
initial/manual action; reopen, restore and another replica never automatically
send pending messages or old protocol effects. Manual retry uses the exact
attempted package, while a new channel means a new message ID. Peer ACKs record
receipt independently of submission. See [channels](channels.md#model) and
[delivery boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage | [Event store](event-store.md), [DASL objects](dasl-objects.md) | Event API, identity/order, object bytes and retention |
| Persistence | [SQLite vault](vault-sqlite.md) | Schema, exclusive ownership, transactions and portable recovery |
| Domain facts | [Vault events](vault-events.md) | Message, attempt, profile and local policy payloads/folds |
| Communication authority | [Channels](channels.md), [Address/display policy](relationships.md) | Fixed channels, exact acceptance pins, directed continuity, display groups |
| Runtime | [Delivery](distributed-delivery.md) | Channel-local identity, ACK paths, fixed packaging and live dispatch actions |
| Deferred extensions | [Replica mediation](replica-mediation.md), [Vault sync](vault-sync.md) | Receipt fan-out and encrypted data synchronization, without outbox takeover |

Ordinary DIDComm messages need no Estoc wire handshake or display relationship ID.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [channels and continuity](channels.md#model) → [relationships](relationships.md#what-it-is-for) → [commit/ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity](dasl-objects.md#reading-guide) → [EventStore/Vault](event-store.md#reading-guide) → [SQLite](vault-sqlite.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas/folds](vault-events.md#reading-guide) → [procedures](vault-events.md#procedures) |
| Implement sending | [Send](distributed-delivery.md#send-an-ordinary-message) → [address selection](relationships.md#ordinary-sending-and-birth-selection) → [package preparation](distributed-delivery.md#preparing-a-package) → [delivery fold](vault-events.md#outbound-message-and-delivery-fold) |
| Implement receiving | [Receive](distributed-delivery.md#receive-a-message) → [resolution](relationships.md#did-resolution-requirements) → [receipt gates](relationships.md#uniform-receipt) → [evidence](vault-events.md#receipt-and-relationship-evidence) → [acceptance](distributed-delivery.md#address-chains-and-observation-membership) → [inbound fold](vault-events.md#inbound-message-and-execution-fold) |
| Back up or recover | [Recovery material](vault-sqlite.md#recovery-material-and-product-requirement) → [export](vault-sqlite.md#snapshot-and-export) → [restore/import](vault-sqlite.md#restore-and-import) → [unfinished receive work](distributed-delivery.md#receive-recovery) |
| Explore future replication | Phase-1 documents first, then [replica mediation](replica-mediation.md#reading-guide) and [vault sync](vault-sync.md#reading-guide) |

<a id="rule-ownership"></a>

## Rule ownership

Change the defining section and align its consumers. ES owns event envelopes,
DO owns raw objects/retention APIs and SQ owns SQLite lifecycle. CH owns channels,
acceptance/link/denial/display-membership events and dispatch authority. VE owns
the remaining domain payloads/folds; DD owns runtime ordering and message/effect
identity; RZ owns DID resolution and address/display policy.

| Rule | Definition | Consumers |
| --- | --- | --- |
| Event envelope and ordering | [ES](event-store.md#the-event) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary) |
| Commit durability | [ES](event-store.md#commit-and-durability-terminology) | [DD boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Storage ownership and recovery | [SQ](vault-sqlite.md#ownership-and-lifecycle) | [VE open](vault-events.md#open-the-writable-full-runtime) |
| Object identity and held roots | [DO](dasl-objects.md#accepted-dasl-cids), [VE retention](vault-events.md#held-roots) | [SQ objects](vault-sqlite.md#objects-and-streams) |
| Channel identity | [CH identity](channels.md#channel-identity) | [VE IDs](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces) |
| Exact channel acceptance/pins | [CH acceptance](channels.md#channel-accepted) | [VE evidence](vault-events.md#receipt-and-relationship-evidence) |
| Directed links, joins and confirmation | [CH continuity](channels.md#continuity) | [RZ rotation](relationships.md#peer-address-changes) |
| Message acceptance | [CH](channels.md#message-accepted) | [VE input fold](vault-events.md#inbound-message-and-execution-fold) |
| Fixed intent and manual dispatch | [CH](channels.md#fixed-outbound-channel) | [VE intent](vault-events.md#message-out), [attempt](vault-events.md#delivery-attempted), [DD send](distributed-delivery.md#send-an-ordinary-message) |
| Inbound/execution IDs | [DD identity](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [VE execution](vault-events.md#inbound-message-and-execution-fold) |
| Content/intent/plaintext normalization | [DD hashes](distributed-delivery.md#canonical-projections-and-hashes), [VE stored content](vault-events.md#stored-message-document) | [VE package](vault-events.md#message-prepared) |
| ACK selection and authorization | [DD ACKs](distributed-delivery.md#durable-end-to-end-acknowledgment) | [VE ACK witness](vault-events.md#delivery-acknowledged) |
| Complete witnesses | [VE witnesses](vault-events.md#complete-observation-witnesses) | [CH links](channels.md#channel-linked), [DD ACKs](distributed-delivery.md#applying-ack) |
| Resolution, cryptographic gate and budgets | [RZ resolution](relationships.md#did-resolution-requirements), [gate](relationships.md#hard-pre-vault-gate) | [CH receipt](channels.md#receipt), [RM pickup](replica-mediation.md#messages-received) |
| Invitations | [CH acceptance](channels.md#admission), [VE invitation fold](vault-events.md#invitation-fold) | [VE disclosure](vault-events.md#did-disclosed) |
| Denial and display groups | [CH policy/display](channels.md#effects-and-recovery) | [VE contact deletion](vault-events.md#delete-a-contact), [profiles](vault-events.md#relationship-profile-fold) |
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
| CH | [Channels and continuity](channels.md#required-conformance-cases) | Phase 1 draft; implementation pending |
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

### Channel core, fixed messages and manual dispatch

This revision supersedes the earlier channel/relationship layering experiment.
It removes cryptographic relationship roots, birth IDs, full relationship scope
paths and cross-channel execution aliasing. Relationships are display groups;
their IDs are UUIDv7 and never enter message/effect/ACK authority. Existing
historical anchors remain locators, not permission to use retired payloads.

Current channel facts are `channel.accepted`, `channel.linked`,
`channel.blocked` and `message.accepted`. Display membership uses
`relationship.channelsSet`; `relationship.contactAssigned` is display-only.
Disclosure permission is `admitChannel`. Profile facts name source channels.
Old `relationship.bound`, both relationship transition events, `message.scoped`,
root-derived allocation/contact IDs and relationship execution transcripts are
retired. Their implementation/tests do not establish current conformance.

`message.out` now fixes `channelId`, `senderDidId` and `recipientDid` at intent
commit, intentionally earlier than the first possible transport call. It has
no relationship/birth metadata. Every call requires a committed
`delivery.attempted`; `delivery.submitted` references that attempt. All manual
retries after an attempt use the exact same package. Unknown outcomes remain
unconfirmed, and import/restore/reopen does not dispatch pending work. A new
channel requires a new explicit send and ID. Automatic pickup, resolution and
sync recovery are separate from replay of user/protocol messages.

Authenticated inbound IDs use `["v2", "authenticated", channelId, senderDid, wireId]`;
execution IDs use `["v3", {"channel": channelId, "sender": senderDid}, wireId]`.
Opposite directions stay distinct. The effect hash/automatic-ID algorithms are
unchanged, but their inputs and published vectors change. Graph discovery never
merges executions. Successor ACKs still require an exact role-preserving path.

CH-1–CH-29 specify the core contract. Existing VE/DD/RZ cases retain their
subjects with updated guarantees. In particular, cross-channel alias fixtures,
automatic recovery sending and rotation-driven repacking expectations are
retired. Invitation consumption now commits with explicit qualifying channel
acceptance, rather than the retired root message scope. Confirmation witnesses
still avoid a dependency on their own message acceptance.

This is a breaking revision of an unreleased v3 domain draft. It requires
development-vault rebuilding or an explicitly implemented conversion; no
migration or implementation conformance is claimed. Event envelopes, raw CID
rules and SQLite tables are unchanged. Storage recovery restores data and local
projections while domain dispatch remains subject to explicit live actions.

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
