# @estoc/vault

What the events of an `.estoc` vault mean. The contract is
[`docs/vault-events.md`](../../docs/vault-events.md) at the repository
root; this package is its reference implementation, and nothing more
than the meaning: no folder, no agent, no protocol, no DID method.

**Version 3 is being built beside this**, under `@estoc/vault/v3`, as
the code form of the
[replica model](../../docs/replica-model/README.md)'s
[vault events](../../docs/replica-model/vault-events.md),
[channels](../../docs/replica-model/channels.md),
[relationship policy](../../docs/replica-model/relationships.md) and
[distributed delivery](../../docs/replica-model/distributed-delivery.md)
over `@estoc/event-store/v3`. What is there so far is the identifier
vocabulary (`types.ts`: one nominal type per kind of value a payload
names, over the validated string it serializes as, and the channel, an
ordered pair of a local and a peer DID), the deterministic
identifiers (`ids.ts`: the three UUIDv5 namespaces derived from the URL
namespace, an inbound observation by its canonical sender, recipient and
wire ID or, anonymous, by the decrypting local key, an execution from
the same three, an effect key over the tagged execution and effect type
and the automatic message ID it names, a channel's key and the order a
set of channels is kept in, the reserved keystore names) and the canonical public-key value
(`public-key.ts`: the did:key encoding of the complete type-tagged key
as base58btc multibase, from a JWK or from its base58btc multibase form,
Ed25519 and X25519 raw, the Weierstrass curves as compressed points that
`@noble/curves` has verified lie on the curve; `agreementKey` is the key
as one that agrees keys, of a type DIDComm v2 runs ECDH over and, for
X25519, not a low-order point, which `@noble/curves` refuses as every
shared secret with it is zero; `@scure/base` does the
base58btc and base64url, `multiformats` the multicodec prefix), the event
schemas (`schema.ts`: `readVaultEvent` / `readVaultDraft` / `vaultDraft`
accept an event of one of the 28 version-3 types — the closed member set
of its payload, each member's type, nullability and spelling, the rules
between members such as a package naming its sender entity's
key-agreement key, an automatic effect's key being its tuple's and a
contact's channel selection sorted by its pair encoding, and the `roots` the type retains — or throw
`InvalidPayload`; what a schema cannot see, whether a referenced event
exists or a JWT verifies, is the folds' and the runtime's, never inferred
here), the stored message document (`document.ts`: `storeMessage`
normalizes a DIDComm `body` and `attachments` into the closed stored
form with its payload objects and roots, `readStoredDocument` reads that
form back, `wireAttachment` puts a descriptor back on the wire only from
a payload of the stored byte count that is, for JSON, already canonical)
and the projections (`projection.ts`: `readPlaintext` takes a plaintext
apart into intent, stored content and addressing, `semanticProjection`
and `intentProjection` return the projection objects, `intentHash` and
`plaintextHash` compute the hashes the events carry over the intent
projection and the exact plaintext, `wirePlaintext` is the inverse of `readPlaintext`, and
`expandPleaseAck` / `requestsAck` read `please_ack` without rewriting
it), the keys and communication DIDs (`identity.ts`: `Keys` opens over
a seed only once it derives the recorded anchor, or `unlock`s the
wrapped seed with the passphrase, and derives each named key on demand,
an Ed25519 key and the keystore's own X25519 key per name, the latter for key agreement;
`mintDid` builds a communication DID's numalgo-4 input document from
the entity's two keys and its route, `mintMediationDid` a mediation
arrangement's from the two keys its one name derives; `checkDidCreated` and
`checkMediationCreated` hold a recorded entity against the seed by
reading its own document back, so another serialization of the same
keys and route is the same entity), the retained peer document
(`peer-document.ts`: `peerResolution` reads a validated long form's
raw bytes as strict JSON, refuses what the method forbids, and returns
the fixed retained representation as object, RFC 8785 bytes and raw
CID; `canonicalDidOf` is the DID folds compare by; `authorizedMethodIds`,
`methodPublicKey` and `didcommServiceUris` read any retained document's
relationships, keys and DIDComm endpoints) and the `from_prior` proof
(`from-prior.ts`: `signFromPrior` issues the compact EdDSA JWT with
`jose`; a carried proof is read in three steps, `fromPriorClaims` for
its form and claims, `carriedClaims` for the claims against the
carrier they arrived on, and `verifyFromPrior` for the signature
against the issuer's immutable document, which `issuerDocumentOf`
derives from a long-form issuer's spelling or takes from a retained
method-valid `peer.resolved` of a short-form issuer and which the
caller must have checked to be that DID's before verifying; DID
spellings compare by validated equivalence and the rest of a method
ID byte for byte; `verifyLocalProof` holds a rotation decision's
frozen proof to the exact counterpart of signing one; what a proof
means for a channel is the continuity fold's), and the first
folds (`fold/`: `VaultEventSet` reads every event once against its
schema and hands a type's events out in canonical order and a typed
reference's target as present, missing or mismatched; `foldAuthors` and
`foldLabel`; `foldMediations`, each arrangement's consistent creation,
one grant, retirement and conflicts, and the preferred one;
`foldRoutes`, each route's usability and terminal dependency, each local
DID entity's consistent record, own document, route target, disclosures,
retirement, faults and liveness, the key-name and spelling reverse maps,
the desired mediator recipients and each entity's receipt eligibility;
`requiredReceivingSet`; `heldRoots` / `foldErasures` / `readState`,
what collection must keep — every root an accepted event retains, a
message's until its erasure releases it, a prepared envelope until
its message is submitted or terminated — and how a root reads, erased
before absent. Every fold is a pure function of the event set, checked
by shuffling; what needs the seed, whether an entity's document carries
the keys its ID derives, is `verifyDidKeys` / `verifyMediationKeys`
beside the fold, whose verdicts are handed back in, `foldWithSeed`
doing both in one motion, and what needs the retained documents,
whether a resolution's snapshot is its document's, is
`verifyResolutions` (`fold/evidence.ts`, `resolvedDocumentOf` reading
the document a resolution names); until the seed has confirmed an
entity it is pending, never live, and until a snapshot has been checked
what rests on it is deferred, never applied), the raw channel
evidence (`fold/channels.ts`: `foldSources`, each `message.in` with the
local entity its key belongs to, the channel its actual endpoints form
and its standing — complete, incomplete while evidence is missing or
the seed has not yet confirmed the local entity, conflict when evidence
contradicts it, the entity is in conflict or the peer key selected
agrees no keys or is on another curve than the entity's own
key-agreement key, each contradiction looked for as soon as what it
needs is here and always reported over an absence; `foldReceipts`, the receipt
ordinals' high-water mark and the messages one author's reused ordinal
affects; `foldCarriers`, each source that brought a `from_prior`,
its proof invalid on the carrier's own evidence, pending while the
issuer's document is not here, or verified, and the peer link a
complete carrier's verified proof derives; `foldDecisions`, each
`did.rotationSelected` checked against its own fields and source into a
local-link candidate, pending while evidence may still arrive, in
conflict when its source can never be positive — anonymous, from
another peer or at another key than the predecessor's, its
authentication contradicted, its proof refused — each refusal made on
the fields it needs, not held for the entities' creations; `foldChannelEvidence` runs the three and says
which sources are `positive`, the ones the continuity graph may be
built from; the signatures are `verifyProofs` beside the fold, each
carried or frozen proof against the issuer's document its long form
derives or a verified resolution retains), the continuity graph
(`fold/continuity.ts`: `foldContinuity` closes the positive evidence
into a graph of channels whose edges replace one endpoint — the peer's
by a carrier's verified proof, ours by a rotation decision once the
peer or a verified successor has written to exactly the predecessor,
that confirmation never coming from the decision's own descendants —
and joins a local and a peer replacement leaving one pair into the
pair of both successors, transporting each to the other's successor;
then, over the whole graph, finds the conflicts, competing successors
of one endpoint in one context, cycles and a join that would pair a
DID with itself; then takes the same closure again, admitting no edge
that touches a conflicted channel, a join's included, over the carriers
and decisions that are complete witnesses — a masked carrier confirms
no decision, a join transports nothing through a conflict — as what
grants authority, each link saying whether it is `verified`; then
answers: each carrier's and decision's six-state `status`, what each
source `witness`es, whether a channel is `conflicted` or `superseded`
in its local-only context, its default `head`, none while a replacement
ahead of it is not granted, whether a local DID is `confirmed` toward a peer, the
role-preserving `ackPath` from an outbound to a carrier, the denials
that cover a channel and the decisions already made in its peer-only
context; a conflict masks authority and removes no edge), the
invitations (`fold/invitations.ts`: `foldInvitations` reads each
one-use OOB disclosure with the consumption records that name it and
the receipts that could consume it; a record is read on its own —
its disclosure a one-use invitation, its source a proof-free complete
witness at the disclosed DID under the invitation's `pthid` — and only
a complete record names the consumer, the source's canonical peer DID;
the invitation is `available`, `consumed`, `pending` while a record
or a candidate ahead of every eligible one waits, `unavailable` while
the disclosed DID is retired, in conflict or not yet created here, or
its route is retired, misconfigured or on a terminal mediation, or in
`conflict` when complete records disagree, any OOB disclosure repeats
the ID, or the walk reaches a candidate caught in a receipt-integrity
conflict before an eligible one; the `candidates` are the unerased
proof-free followers in first-receipt order, each `eligible`,
`deferred`, `refused` by the DID's lifecycle or by the channel's
current denial, continuity conflict or supersession, `invalid` by its
own witness or by the intent conflict of the input it observes, or in
`integrity-conflict`, for the runtime to walk when it records a
consumption, the fold recording none), the
contacts (`fold/contacts.ts`: `foldContacts` is a table of latest-wins
decisions under each contact ID — tombstone, petname, flags, local-DID
preference, the whole channel selection replaced or cleared, merge
hints from either side — and `selecting` names the undeleted contacts
whose selection holds a channel), the inbound
inputs (`fold/inbound.ts`: `foldInbound` groups every authenticated
observation whose own authentication is complete into the input its
canonical sender, recipient and wire ID name, one execution per input
in its channel, its members in first-receipt order; the members whose
proof, if any, supports a link must agree on the intent, and a
disagreement is a `conflict` for good, whatever later becomes of
those members' witnesses; the input is `complete` once one member is
a complete witness under the continuity, `pending` otherwise, and a
member whose proof is refused or not yet verified neither makes a
conflict nor clears one; the observations of the input whose own
authentication is incomplete or contradicted are its `siblings`,
listed and counted for nothing, those with no input to join are
`unplaced`, and the `anonymous` ones are apart; each complete input
has the agreed intent's `kind` — application, pure ACK in its exact
shape, any other Empty message, ping-response or problem report — its
`firstReceiptKey` for freezing ACK targets in order, and whether an
erasure names it), the outbound
messages (`fold/outbound.ts`: `foldOutbound` reads, for each message
ID, the intent its `message.out` records must agree on and the
channel its sender entity and canonical recipient fix; every distinct
preparation, each checked against the intent and its own resolution
evidence — the peer key it selected on the curve the sender's own
key-agreement key is on — one being the `package` and two a conflict
with no winner; each `delivery.submitted`, complete when a complete
preparation carries its package ID, so that under a consistent intent
`submitted` is a fact no unrelated, competing or later evidence
withdraws; each `delivery.failed`, an expiry counting only against an
intent that expires; the `ackWitnesses`, once a complete package is
here, the complete witnesses whose `ack` names the message in its
channel or over a verified role-preserving path, the recorded
`delivery.acknowledged` checked against the carriers each names — any
one under the peer's authorized keys matching in full, one still short
of its own evidence keeping the record pending — and `late` by the
earliest witness against the expiry; an intent derived from an input
has its `effect` checked against the input's execution, the source's
witness, the output's channel — the source's, or a verified local
successor keeping the peer, a path not verified yet being pending
unless continuity is in conflict — and the built-in operation's shape — a pure ACK's frozen
targets each requested by the source and established for it — and a
notification against its decision's continuity and selection, a
control input triggering none; the `outcome` in the order conflict,
submitted, terminal, prepared, queued, and the `work` left — a package
to prepare, or one to dispatch, neither while a submission names a
package still to arrive nor through blocked or conflicted continuity,
the runtime alone deciding whether to make the call; the messages
whose envelope contribution is `released`, submitted or terminated
under a consistent intent, which the held roots drop;
`notificationFor` a decision, one intent selecting and several
conflicting; `ackTargets` a carrier's request names, established
inputs of its channel or a verified predecessor in first-receipt
order, the carrier's own by its exact source; and `inReplyTo`, the
outbound a ping-response or problem report answers), the whole fold
(`fold/vault.ts`: `foldVault` runs every fold over one set, each fed
the ones it reads, and adds the retention edge by edge and the roots
it holds; `checkVault` computes every verdict beside it in one motion,
the seed's and the documents', `objectReader` reading the vault's
objects with absence, damage and excess size each as no verdict;
`scanVault` is one scan of a vault, the checks and the fold), the views
(`fold/views.ts`, reached as `fold.views`: a channel with its inputs in
first-receipt order, the outbounds fixed to it, the problem reports
peers sent beside the outbound each one's thread names when the carrier
may answer it, and its send gate — the local DID live, the pair not
denied, its continuity not in conflict, and for automatic work the
peer not moved on, which `senderGate` / `channelPolicy` decide; and a
contact, or several shown as one, as the channels it selected followed
by the related history verified continuity connects to them, each
message once and each in its own channel, with `writeTo` the distinct
heads of the selected channels that take a new send now, a `useDid`
preference matched to the heads at that DID or at a verified local
successor of it on the way there, and `defaultWriteTo` only when one
head is left, never a predecessor in place of an unusable head) and
the procedures (`procedures.ts`: `vaultRetention` / `vaultHeldRoots`
hand the event store the fold's retention for collection, export,
validation and import, and `collectGarbage` is one pass;
`eraseMessage` erases a message over every root its events and
packages still name, in one commit, and `closeErasures` appends the
equivalent erases a later observation or package made an erased
message owed, `eraseDrafts` / `erasureClosure` being the decisions;
`consumeInvitations` records the consumption each available one-use
invitation is owed, the first candidate receipt that may be recorded
now, refused and invalid ones passed over and a waiting one stopping
the walk, `consumptionDrafts` being the decision; `unfinishedWork`
lists what an open finds and dispatches nothing of — the outbounds
still to prepare or dispatch, the pure ACKs and Ping replies
established inputs may still be given, each a candidate the manual
completion still holds to current policy and to what the body says,
under `responseChannel`, the carrier's own channel while its local DID
sends there and otherwise the unique verified local successor head
keeping the peer, the notifications verified decisions permit while
their source, an application input, stays eligible, the decisions
whose notification intents disagree, the proofs waiting for issuer
material, and the consumptions; `automaticIntent` names an
operation's tuple over an input, its message ID and the intent already
under it; `decisionFor` is the decision a rotation away from a pair
reuses, defers on or refuses over, from its verified peer-only
context; `blockChannels` denies pairs once each, `deleteContact`
appends the tombstone with the denials and erasures the product chose
alongside, `blockDrafts` / `deleteContactDrafts` being the decisions).
Every published
identifier and public-key vector of those documents is a test in
`test/v3/`, and the DIDs and signature a fixed seed derives are pinned
there too.

A version-2 vault is an event log — one append-only log per device,
merged by union — and everything a person sees in it is a *fold* over
the set of events: contacts, channels, messages, my keys and devices,
invitations, deliveries. The store that holds the events, the folder
that serializes them, blobs, local state and interchange are
[`@estoc/event-store`](../event-store/README.md)
([`docs/event-store.md`](../../docs/event-store.md),
[`docs/vault-folder.md`](../../docs/vault-folder.md)); the store knows no
event type. This package is the first layer that does.

```
@estoc/agent-core      the agent: DIDComm, mediation, delivery, the handlers
  ├─ @estoc/vault        what the events mean: types, folds, procedures, keys minted by name   ← this package
  └─ @estoc/event-store  the folder: events in devices/<dev>/<seg>.jsonl, blobs/<cid>, config.json, keystore.json, local/
       └─ VaultBackend   bytes: OpfsBackend (browser) · FsBackend (Node, @estoc/event-store/node) · MemoryBackend (tests)
```

## What is here

- **The event types** (`types.ts`, `docs/vault-events.md` §2–§6): what
  `data` holds under each `type` — `did.minted`, `did.published`,
  `did.registered`, `did.retired`, `mediation.created`,
  `mediation.granted`, `mediation.retired`, `device.minted`,
  `device.label`, `identity.label`, `channel.firstSeen`,
  `peer.resolved`, `peer.rotated`, `message.in`, `message.out`,
  `message.erased`, `delivery.attempted`, `delivery.held`,
  `contact.created`, `contact.attached`, `contact.detached`,
  `contact.merged`, `contact.useKey`, `contact.petname`, `contact.flag`,
  `contact.deleted`, `profile.nameClaimed`, `profile.shared`,
  `extension.installed` / `removed` / `purged` — and `readVaultEvent`,
  which tells a line of one of these types from a line that only claims
  to be (a `Malformed` is kept, never applied). Key names
  (`anchor`, `did/<id>`, `mediation/<id>`) and `channelId` /
  `sameChannel` over a `ChannelKey` live here too.
- **The peer key** (`peerKeyOf`, `fingerprint`, §3): a channel is
  `(my key name, their public key's fingerprint)` —
  `base32lower(sha256(multicodec-prefixed raw public key))[0:26]`, the
  hash of the bytes a `did:key` of that key encodes — so a peer who
  rotates their DID but keeps their key stays the same channel, and one
  who rotates their key is a `peer.rotated` edge between two.
- **The fold** (`VaultFold`, §7): one class over one `EventSet`, with
  `self` (this device) as its one parameter. Pure and order-free: the
  projection is a function of the set, recomputed as each event is
  applied, so events arrive in any order, one at a time, and the result
  is the same (`test/properties.test.ts` shuffles a scene and checks).
  `contacts()`, `contact(cid)`, `deletedContacts()`, `channels()`,
  `channel(pair)`, `attribution(pair)` (channel → `cid`, §7.1),
  `myKeys()`, `myKey(name)`, `devices()`, `label()`, `invitations()`,
  `messages()`, `message(mid)`, `delivery(mid)`, `held()`,
  `erased(mid, root)`, `extensions()`, and `malformed` for what was
  refused. `VaultFold.of(events)` folds a store; `apply(event)` advances
  it.
- **Drafts** (`drafts`): one constructor per type for what `append`
  takes, `blobs` filled in where the type references roots.
- **The procedures** (§8–§10): what a device appends when a person acts,
  each a set of ordinary events decided over the fold and the fold
  advanced as they land. `record` / `recordAll` (append and fold in one
  motion), `recordMessage` (the skeleton with its body and attachments
  put to blobs first), `eraseMessage` and `readRoot` (an absence is
  `erased`, `present` or `missing`, §8.2), `collectBlobs` (the keep-set,
  §8.3), `deleteContact` and `sweepDeleted` (§9), `noteFirstSeen` /
  `notePeerResolved` (channel observations, deduplicated), and
  `holdImported` with `importPolicy()` — the vault's `ImportPolicy` for
  `@estoc/event-store`'s import: an outbound message of another device's
  that arrives without an outcome is held, never sent by this one
  (§10).
- **Keys** (`Keys`, §2, §5) over `@estoc/keystore` v3: one seed, keys
  derived by name, the log the truth about which names exist and
  `keystore.json`'s `keys[]` a cache of it. Every mint appends the event
  that names the key first and writes the cache second (`mintDid`,
  `createMediation`; `rebuildCache` re-derives the cache from the fold).
  What a key is minted *as* is the caller's: a `MintDid` —
  `(identity, serviceUri) => { did, … }`, deterministic — turns a
  derived key and a routing DID into a did:peer:4 (`@estoc/agent-core`)
  or anything with a `did` (a test); `verifyAnchor` checks the recorded
  anchor DID against the seed rather than trusting the file.
- **The folder, opened for an identity** (`createFolderVault`,
  `openFolderVault`): `@estoc/event-store`'s `FolderVault` plus the
  anchor fixed in `config.json` at creation, the seed checked against it
  on every open, `Keys` beside it, and the fold over every device's
  events — the application's first read. Returns
  `{ vault, keys, fold, anchor }`. A version-1 folder, or any folder that
  is not a vault, is refused with `NotAVault`; there is nothing to
  migrate.

## Usage

```ts
import { createSeedKeystore } from "@estoc/keystore";
import { MemoryBackend } from "@estoc/event-store";
import { createFolderVault, drafts, record, type MintDid } from "@estoc/vault";

const mint: MintDid = (identity, service) => ({ did: /* your DID method over identity + service */ });
const { doc, seedKey } = await createSeedKeystore(passphrase);
const { vault, keys, fold } = await createFolderVault(new MemoryBackend(), doc, seedKey, { mint });

await record(vault.events, fold, drafts.identityLabel({ name: "Alice" }));
const { event, key } = await keys.mintDid(fold, null);   // did.minted, key did/<id>
fold.myKeys();                                             // [{ name: "anchor", … }, { name: key, … }]
```

To open the same folder later: `openFolderVault(backend, seedKey, { mint })`.
With did:peer:4 and a mediator, use `openVault` / `createVault` from
`@estoc/agent-core`, which binds `mint` and adds the agent on top.

## Development

```
pnpm test       # vitest: types, the fold and its properties, procedures, identity
pnpm build      # tsc → dist/
```

## License

Apache-2.0
