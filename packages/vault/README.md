# @estoc/vault

What the events of an `.estoc` vault mean: the code form of the
[replica model](../../docs/replica-model/README.md)'s
[vault events](../../docs/replica-model/vault-events.md),
[channels](../../docs/replica-model/channels.md),
[relationship policy](../../docs/replica-model/relationships.md) and
[distributed delivery](../../docs/replica-model/distributed-delivery.md)
over `@estoc/event-store`, and nothing more than the meaning: no
storage, no agent, no protocol. What is here is the identifier
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
accept an event of one of the version-4 types — the closed member set
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
(`from-prior.ts`, over `@estoc/continuity/from-prior`, which owns the
profile, the parsing, the precheck, the signature and the receipt
binding: `signFromPrior` signs a local rotation through the package with
the key the seed derives for the predecessor entity, under the method
its own document gives that key, and `issuerLongFormOf` finds the long
form a carried proof verifies against, the issuer's own spelling or the
one a verified retained `peer.resolved` of a short-form issuer holds;
what a proof means for a channel is the continuity fold's), and the first
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
affects; `foldCarriers`, each source that brought a `from_prior`: the
package's precheck refuses, before any document, what the profile
decides on its own — the algorithm, the media type, a `kid` of another
DID, a subject that is the issuer or not the authenticated sender, a
validity window — an ending is set aside as `unsupported`, a proof
whose signature the checks beside the fold verified is bound to its
receipt, and a bound proof on a complete carrier is the peer
transition and the observation of the successor, both facts of that
one receipt; `foldDecisions`, each `did.rotationSelected` checked
against its own fields and source into a local-decision fact, pending
while evidence may still arrive, in conflict when its source can never
be positive — anonymous, from another peer or at another key than the
predecessor's, its authentication contradicted, its proof refused —
each refusal made on the fields it needs, not held for the entities'
creations; `foldChannelEvidence` runs the three and says which sources
are `positive`, the ones the continuity facts are projected from; the
signatures are `verifyProofs` beside the fold, each carried or frozen
proof against the long form its issuer presents or a verified
resolution retains), the continuity (`fold/continuity.ts`:
`projectFacts` turns the evidence into `@estoc/continuity` facts under
IDs every replica derives from the same event CIDs — the observation
of a complete proof-free receipt, the transition and observation of a
bound proof, the decision of a `did.rotationSelected` that passes its
own checks, naming its source's observation — and `foldContinuity`
hands them to the package's `deriveContinuity`, which owns the links,
the joins, the contexts, the conflicts, the heads, the paths and the
confirmation; the fold reads that model beside the evidence's own
verdicts: each carrier's and decision's `status`, `unsupported` for an
ending, what each source `witness`es, a proof-free receipt on its own
authentication alone, whether a channel is `conflicted` — a conflict
reaches it or what lies ahead of it — or `superseded` in its
local-only context, its `head`, the channel itself when no fact
mentions it and none while a replacement ahead waits, conflicts or is
not unique, the admitted observation a local DID is `confirmedBy`
toward a peer for new work — the model confirms by every usable one,
and a saved decision rests on those — the
role-preserving `ackPath` from an outbound to a carrier, the denials
that cover a channel through the history and the decisions of a
peer-only context whether or not they are projected; the package's
`model` is exposed for what those do not summarize), the
admissions (`fold/admission.ts`: `foldAdmissions` reads each
`message.admitted`, the runtime's acceptance of one exact observation
for application use, against its source — `effective` when the source
is positive evidence on its own and no author gave its ordinal to
another observation, `pending` while the source or its evidence is
still to arrive, `invalid` for good — and says which observations are
`admitted`; `foldDispositions` gives every observation its
disposition, `refused` for good, `admitted`, `ignored-superseded` once
the peer moved on without one, or `pending-admission` with what stands
in the way, and lists the `candidates` no effective or pending
admission names, in first-receipt order, each `eligible`, `deferred`
for evidence, `refused` by current policy — the peer's replacement, the
channel's denial, a conflict in the continuity its proof needs, a
contradiction of the intent its input admitted — `invalid` or in an
`integrity-conflict`, for the runtime to walk when it records
admissions, the fold recording none), the
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
`deferred` for evidence or for the admission it is still owed,
`refused` by the DID's lifecycle, by the channel's current denial,
continuity conflict or supersession or by whatever refuses its
admission, `invalid` by its own witness or by the intent conflict of
the input it observes, or in `integrity-conflict`, for the runtime to
walk when it records a consumption, the fold recording none), the
contacts (`fold/contacts.ts`: `foldContacts` is a table of latest-wins
decisions under each contact ID — tombstone, petname, flags, local-DID
preference, the whole channel selection replaced or cleared, merge
hints from either side — and `selecting` names the undeleted contacts
whose selection holds a channel), the inbound
inputs (`fold/inbound.ts`: `foldInbound` groups every authenticated
observation whose own authentication is complete into the input its
canonical sender, recipient and wire ID name, one execution per input
in its channel, its members in first-receipt order; the members an
effective admission names must agree on the intent, and a
disagreement is a `conflict` for good, whatever later becomes of
those members' witnesses; the input is `complete` once one admitted
member is a complete witness under the continuity, its
`firstWitness`, `pending` otherwise, and a member no admission names
neither makes a conflict nor clears one, one whose intent differs
from the admitted one being listed as `contradicting`; the observations of the input whose own
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
here, the admitted witnesses whose `ack` names the message in its
channel or over a verified role-preserving path, the recorded
`delivery.acknowledged` checked against the carriers each names — any
one under the peer's authorized keys matching in full, one still short
of its own evidence keeping the record pending — and `late` by the
earliest witness against the expiry; an intent derived from an input
has its `effect` checked against the input's execution, the source's
witness, the output's channel — the source's, or a verified local
successor keeping the peer, a path not verified yet being pending
unless continuity is in conflict — and the built-in operation's shape — a pure ACK's frozen
targets each requested by the source and established for it, or, while
no input is, witnessed for it by a complete observation no admission
names — and a
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
may answer it, and its send gate — the local DID live and not
replaced here by a decision, made or still waiting, the pair not
denied, its continuity not in conflict and its peer not moved on,
which `senderGate` / `channelPolicy` decide for every path to the
wire, a user send, a reply, a package and a call alike; and a
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
`reconcileAdmissions` records the admissions the observations are
owed, in first-receipt order and round by round under the lock, each
round the first eligible candidate of each input and the fold read
again over the extended set before the next, so that a consistent
duplicate is admitted after the first and a contradicting one refused
against it, `admissionDrafts` being one round's decision and
`admitReceipts` the pass under a lock already held;
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
`test/`, and the DIDs and signature a fixed seed derives are pinned
there too.

## Development

```
pnpm test       # vitest: identifiers, schemas, keys and proofs, the folds, the procedures
pnpm build      # tsc → dist/
```

## License

Apache-2.0
