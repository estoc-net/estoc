# Continuity domain package design draft

Status: **Exploratory proposal. Not implemented; the current phase-1 contract is unchanged.**

The proposed package, `@estoc/continuity`, provides a pure continuity model and a
`from-prior` module for DIDComm proofs. An agent supplies receipt evidence,
issuer documents and saved local decisions. The package verifies proofs, binds
them to endpoint evidence, and derives continuity from normalized facts. The
agent uses the results to conduct its own transactions and protocols.

This draft defines the domain boundary, required information and available
queries, including a [merge contract](#merge-contract) for replica histories.
Types and function names illustrate that boundary; they are not a frozen API.

The domain is **continuity between oriented DID pairs**: rotation, ending,
joins when both endpoints rotate, address confirmation and evidence conflicts.
Message content is unnecessary. Supporting the existing Estoc model does,
however, require more than JWTs: their pair context, saved local decisions and
minimal observations of which address a peer actually used.

<a id="boundary"></a>

## 1. Domain boundary

The package answers how an endpoint pair evolves under the supplied evidence,
and what supports each conclusion. The agent decides whether to perform an
application operation using that conclusion.

```mermaid
flowchart LR
    Agent[Agent: receipt and local decision evidence] --> Proofs[Package: from-prior verification and binding]
    Proofs --> Facts[Normalized continuity facts]
    Observed[Agent: authenticated proof-free observations] --> Facts
    Facts --> Model[Package: pure continuity model]
    Model --> Results[Head, path, confirmation and conflicts]
    Results --> Operations[Agent: policy, transactions and protocols]
```

| Question | Package responsibility | Agent or other module responsibility |
| --- | --- | --- |
| Is this a valid rotation or ending proof? | Parse the JWT, validate claims, check issuer key authorization and verify the signature under the supported profile | Obtain the exact issuer document and retain the original evidence |
| Which endpoints does this receipt establish? | Bind the verified proof to supplied receipt evidence and produce scoped facts | Decrypt and authenticate the envelope; establish the actual local recipient and sender |
| Did B0 become B1 in this relationship? | Derive links, contexts and supersession from normalized facts | Use the result under application policy |
| What pair follows rotations by both parties? | Derive joins and a unique head | Select new message endpoints and check their operational availability |
| Does the peer know A1? | Derive confirmation from exact address observations and continuity | Supply authenticated observations and impose any additional operation policy |
| Does the evidence conflict? | Retain branches and report affected contexts; provide no winning-branch selection in the first version | Present diagnostics and obtain additional evidence |
| May this message be processed, replied to or acknowledged? | Provide directed paths that preserve endpoint roles and their supporting evidence | Admission, message identity, ACK targets, thread correlation, protocols and user policy |
| Which channels belong to a contact? | Provide evidence-backed channel history | Contact selection, names, merging, deletion, preferences and UI |
| Can the next operation be created or sent? | Provide continuity queries and proof construction | Local lifecycle, denial, keys, routes, locking, commits, packaging and dispatch |

The package needs no message body, message type, wire ID, ACK list, invitation,
contact ID or vault event envelope. Its public API provides no `canSend()`,
`admitMessage()` or `CommitPlan`. The model has no side effects. Proof creation
uses a signing capability supplied by the host; it does not manage a keystore.

### How far can the input be restricted to from_prior?

| Available information | What it supports | What remains unavailable |
| --- | --- | --- |
| JWT claims alone | The issuer's declared successor or ending, subject to verification | Local/peer roles, the relevant pair and receipt context |
| Verified proof plus roles and pair evidence | Scoped peer changes and the peer side of joins | A local decision saved before notification, and knowledge of a new local address |
| Saved local decisions and minimal address observations as well | The complete continuity model proposed here | Application admission, message protocols and operation eligibility |

The package centralizes the proof rules and continuity rules. It remains
independent of the business meaning of messages carrying those proofs.

<a id="package-api"></a>

## 2. Package entry points and proof processing

Two public entry points separate proof processing from graph derivation:

| Entry point | Input | Output and responsibility |
| --- | --- | --- |
| `@estoc/continuity` | Compatible snapshots of normalized facts | Pure fact merging and synchronous, deterministic continuity queries without JWT parsing, cryptography or I/O |
| `@estoc/continuity/from-prior` | Original JWTs, issuer evidence, receipt context, or a proof creation request with a signer | Parsing, verification, context binding and proof creation under the package's supported profile |

The proof module depends on shared domain types and maintained JOSE/DID
libraries. The model entry point does not import that module or its
cryptographic dependencies. Neither entry point imports vault, agent-core or
storage APIs. The proof module has no built-in network resolver or object
reader; the host obtains and supplies documents and evidence.

The initial proof profile follows Estoc's immutable `did:peer:4` endpoints and
Ed25519 signing keys. That support must be explicit. Additional DID methods or
algorithms require defined validation and document-version rules; accepting
arbitrary keys from a caller is not a substitute for issuer authorization.
General-purpose JWT login or authorization policy is outside this package.

### Parse and verify a proof

The proof module owns JWT form and encoding checks, supported protected-header
parameters, algorithm restrictions, claim validation, issuer/document binding,
key authorization and signature verification. Use maintained JOSE and DID
libraries for their standard algorithms and validation APIs. Any extra strict
parsing must cover a concrete profile requirement that those APIs do not supply.

An inspection API may expose unverified claims so the host can locate issuer
material. Its output must remain distinct from a verified proof. Decoding a
JWT supplies no continuity fact.

Verification receives the original token and exact issuer evidence. Its result
retains the verified rotation or ending claims and provenance: original token,
original DID spellings, canonical endpoint identities, document reference and
verification method. Preserve the signed bytes; normalization for comparisons
does not rewrite the token or its retained document. Verification caches must
be tied to this evidence and the verifier/profile version.

Missing material and failed verification remain distinguishable. The host can
fetch missing material and retry; the pure model does not perform that work.
A verified proof establishes the issuer's declaration, before any receipt
binding or graph conflict analysis.

### Bind a proof to receipt evidence

Binding is part of the package's `from-prior` module. The host supplies the
exact receipt reference, its unchanged carried token, actual local recipient,
and authenticated sender when present. It preserves the presented DID spelling
as well as its validated canonical identity for profile-specific comparisons.
These are results of envelope verification, not unchecked plaintext headers.

For rotation, binding checks that the verified token is the receipt's own token
and that its subject matches the authenticated sender under the profile. It
then produces a peer transition at the old pair and an address observation at
the received pair, retaining their shared receipt reference. The issuer supplies
the old peer endpoint; the receipt supplies the fixed local endpoint.

Fact IDs are supplied by the host and remain stable across rebuilding. The
module does not allocate database IDs or silently use arrival order. Binding
reports a mismatch or missing context without producing affirmative facts.
Ending requires the additional context rule discussed under
[relationship ending](#ending); a verified ending token alone does not satisfy it.

The intended flow for a successfully verified and bound rotation is:

```ts
import { deriveContinuity } from "@estoc/continuity";
import { verifyFromPrior, bindFromPrior } from "@estoc/continuity/from-prior";

const proof = await verifyFromPrior(jwt, issuerEvidence);
const binding = bindFromPrior(proof, receiptEvidence, {
  transitionId: "p1",
  observationId: "o1",
});

if (binding.status === "bound") {
  const model = deriveContinuity([...history, ...binding.facts]);
  const head = model.head(selectedChannel);
}
```

A consumer may also supply normalized facts directly to the model when it
implements the same evidence contract. This entry point is a trusted in-process
boundary, not a mechanism for authenticating imported `verified: true` flags.

### Create a proof

The package provides proof creation for rotation and ending. It owns the claim
shape, protected header, encoding and consistency checks. The host supplies the
issuer, selected successor or ending, rotation time, issuer evidence and signing
capability. The package does not choose when to rotate, allocate a successor or
read the clock implicitly.

The signing capability must correspond to a key authorized by the issuer's
profile. Validate the returned proof against the requested claims and issuer
evidence before returning it for persistence. Cryptographic operations use
maintained libraries or the supplied signing provider; the package never reads
a vault seed or manages key storage. The precise signer interface remains an
API design choice, including how to support non-exportable keys.

The host saves the chosen proof with its local decision, commits any dependent
notification, and controls dispatch. Generating a proof neither creates a
saved decision nor authorizes sending it.

<a id="identity"></a>

## 3. Identity in the model

A channel is a fixed `C(localDid, peerDid)` with distinct DIDs and fixed roles.
Rotation produces another channel; it does not rewrite existing message pairs.

A `Did` in the model is an already validated canonical identifier. The model
compares identifiers exactly and does not parse documents. Shared keys,
services or contacts do not merge endpoints. Method-specific validation lives
in the proof profile and the host's endpoint authentication; the model itself
is independent of DID method encoding.

B0 appearing in both `C(A0,B0)` and `C(X0,B0)` does not establish a shared
rotation context. For peer changes, a context consists of pairs connected by
local-only links while retaining that peer. Local changes use the symmetric
context through peer-only links. Contexts are derived; no permanent
`relationshipId` replaces the pair.

Pair contexts, local decision prerequisites and conflict handling are model
choices carried forward from Estoc. DIDComm defines the wire proof and its
processing requirements. Those scopes remain separately documented.

<a id="inputs"></a>

## 4. Minimal model inputs

The model receives a snapshot of facts. `FactId` and `EvidenceRef` are stable
opaque references that the host can map to original records; the model does not
dereference evidence. Each fact ID is intended to identify one immutable value
across replicas and remains stable across rebuilding. Conflicting values under
one ID are retained under the merge contract rather than overwritten. Evidence
references identify exact immutable sources. Different carriers of one proof
retain their separate provenance.

Event timestamps, receipt order and authors are unnecessary for graph
selection. The proof module validates JWT `iat`; it does not use it to choose
a winning branch.

```ts
type Did = string;
type FactId = string;
type EvidenceRef = string;
type Channel = Readonly<{ localDid: Did; peerDid: Did }>;

type Change =
  | { kind: "rotate"; successor: Did }
  | { kind: "end" };

type PeerTransition = {
  kind: "peer-transition";
  id: FactId;
  at: Channel;
  change: Change;
  receipt: EvidenceRef;
};

type LocalDecision = {
  kind: "local-decision";
  id: FactId;
  at: Channel;
  change: Change;
  source: FactId | null;
  decision: EvidenceRef;
};

type AddressObservation = {
  kind: "address-observed";
  id: FactId;
  at: Channel;
  carriedTransition: FactId | null;
  receipt: EvidenceRef;
};

type ContinuityFact = PeerTransition | LocalDecision | AddressObservation;
```

### Peer transition

`at` fixes the predecessor pair. A rotation successor replaces only the peer:
`C(A0,B0)` with successor B1 supports `C(A0,B0) -> C(A0,B1)`. An ending records
a terminal assertion by B0 in that context without a successor.

A peer transition requires the proof module's verification and binding
contract: a valid issuer declaration, the exact carrier's authenticated
endpoint evidence, and their checked correspondence. An ending additionally
requires the agreed context binding. The host retains the original JWT,
documents and receipt evidence behind the reference.

This input is an independently verified assertion, not a conclusion about its
usability in the whole graph. B0-to-B1 and B0-to-B2 may each pass verification;
the model still reports their conflict in a shared context. Another carrier
cannot supply missing authentication or proof verification for this one.

### Local decision

A local A0-to-A1 decision may be durable before any notification is sent. The
model needs that saved choice rather than waiting for an inbound carrier.

The host establishes local endpoint ownership and durable decision identity.
The package verifies the saved proof and its agreement with the decision's
issuer and successor or ending. A decision with a source references the exact
`address-observed` fact selected by the host. The model checks that source's
pair and continuity dependencies; business content and application admission
remain outside it.

A local rotation is a candidate link until the model finds independent
confirmation of its exact predecessor address. Without that confirmation it
retains the candidate and its waiting reason. This draft proposes no address
confirmation prerequisite for an ending, which establishes no successor;
permission to create that local decision remains host operation policy.

The host allocates the successor, invokes proof creation and atomically saves
the relevant records. The model consumes saved decisions and allocates nothing.

### Address observation

An observation at `C(A1,B0)` establishes that one exact authenticated receipt
was from B0 to local A1. It carries no wire ID, body, protocol or handler result.

The receipt may have no `from_prior`. This extra information is essential to
confirmation: a declaration that A0 became A1 cannot establish that the peer
has learned A1.

`carriedTransition: null` means the receipt really carried no proof. When a
rotation proof was present, the observation must reference its own peer
transition. The model checks the shared receipt reference, local recipient and
successor peer. A pending or invalid proof cannot be dropped to turn its carrier
into a proof-free observation. An ending carrier supplies no observation with
a current authenticated sender through this path.

A valid rotation carrier can produce both a transition and an observation with
different fact IDs and the same receipt reference. A consumer interested only
in peer topology may omit observations; missing confirmation then remains
missing, including for local rotation candidates.

### Verification gaps and snapshot completeness

The host retains pending or invalid source records and the proof module's
diagnostics. Only facts satisfying their own evidence contract enter the model.
Verified conflicting branches are retained regardless of head selection,
blocking or application admission.

The model checks fact structure, references and graph semantics. It cannot
reconstruct cryptographic evidence omitted by an untrusted caller; a branded
verified-proof type helps prevent accidental misuse but is not a security
boundary for imported data.

Every query is relative to the supplied facts. The model cannot establish that
unknown history does not exist or count proofs awaiting verification outside
its input. The host combines model results with material, verification and
binding diagnostics. A temporary unique head does not satisfy an operation's
missing exact prerequisites.

Before allocating a successor, the host must also inspect all saved decisions,
including ones that cannot yet be projected. An empty model decision query does
not authorize allocating another successor when a saved choice lacks evidence.

<a id="merge-contract"></a>

## 5. Merge contract

The model is designed for CRDT-like convergence: replicas with the same
normalized fact variants and model profile derive the same continuity state,
including domain conflicts. This section defines the proposed merge semantics;
the package and its integration with replica synchronization remain unimplemented.

### 5.1 Scope and compatibility

A merge operates within one logical local identity, with the same local/peer
orientation and evidence trust policy. It does not combine the opposite
perspectives of two communicating agents. A host supplies an identity namespace
and a versioned profile identifying the fact schema, normalization, proof rules
and derivation rules. These tags are compatibility checks, not credentials.
The host authenticates imported source records under its replication trust model;
possession of a replica ID does not authenticate a receipt or local decision.
This source acceptance concerns provenance and integrity, independently of
application admission or current denial policy.

Merge rejects incompatible namespaces or profiles without changing either
input. Unknown versions require an explicit conversion before merging; a
consumer must not drop unknown fields to make a newer fact appear compatible.

The core can expose this shape without learning any storage or transport API:

```ts
type FactSnapshot = Readonly<{
  identityNamespace: string;
  profileVersion: string;
  facts: readonly ContinuityFact[];
}>;

declare function mergeFacts(
  left: FactSnapshot,
  right: FactSnapshot,
): FactSnapshot;

const merged = mergeFacts(left, right);
const view = deriveContinuity(merged.facts);
```

The matching model implementation interprets the profile. Scope/version tags
do not change fact meaning or authorize a caller to relabel another identity's
history. Direct model calls follow the same compatibility and evidence contract.

### 5.2 Identity and equality

The host allocates globally unique, persisted fact IDs in the namespace. An
imported source retains its IDs; an independently recorded receipt has its own
ID even if it carries the same JWT. Projection IDs can be derived from a stable
source ID and fact kind, or saved with that source. Rebuilding must not allocate
new IDs. Local row positions, wall-clock time alone and import order are not
identity schemes.

Within one profile, exact equality means identical canonical bytes for the
entire schema-valid fact, including its ID, kind, endpoints and references.
Use [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) through a maintained
implementation. Required nulls are explicit; missing required fields and extra
fields fail the version's schema. Object property order is irrelevant, while
string values and source references remain exact. This encoding is for fact
comparison; it does not canonicalize or rewrite a signed JWT.

Local receipt positions, verification-cache timestamps and diagnostic display
text are outside fact equality. Evidence references are also stable across
replicas and identify immutable material. A host must not resolve the same
reference to whichever local document happens to be available.

### 5.3 Union and merge laws

Logically, a snapshot maps each fact ID to a set of distinct canonical values.
The public facts array can represent these values without introducing a new
stored event type. A bucket with multiple values is retained in full.

```text
merge(A, B)[id] = A[id] union B[id]

merge(A, B) = merge(B, A)
merge(merge(A, B), C) = merge(A, merge(B, C))
merge(A, A) = A
```

These laws apply to compatible, schema-valid inputs and compare retained
values, independent of array enumeration order. Merge returns a new snapshot;
it does not mutate an input. Exact duplicates add nothing. Different IDs retain
their distinct provenance even when they establish the same graph edge.

No last-writer-wins rule, replica priority, JWT time or delivery order selects a
value. For reproducible serialization and diagnostics, enumerate IDs and then
canonical values in UTF-8 byte order; this order grants no domain precedence.

There is no deletion, replacement or conflict-clearing merge operation in this
version. A transport may send deltas, but omission from a partial transfer never
deletes a retained value. Local cache eviction is not evidence deletion. Any
future compaction must preserve the information required to reproduce identity
conflicts, dependencies and query results before it can replace this full set.

### 5.4 Collisions and domain conflicts

Two values under one fact ID are an **identity conflict**. Keep both, expose the
variants, and make no selection between them. The conflicting identity supplies
no usable witness or link. References to it, including a decision's `source`
and an observation's `carriedTransition`, report conflict rather than choosing
a value or treating the reference as merely absent.

Retain every variant's endpoint claims for diagnostics and conflict scoping.
Include their independently established changes in positive conflict analysis,
without resolving an ambiguous reference to a chosen variant. Any join,
confirmation or path relying on that identity loses that support. A head query
must not hide a collided forward change and fall back to the predecessor.
Independent, unambiguous support for the same change may remain usable when no
alternative creates a competing continuation or other context conflict; it
cannot hide such an alternative. Queries whose continuation remains ambiguous
report conflict, while unrelated contexts remain usable. The input-conflict
representation retains variant values, not just their shared ID.

Different IDs declaring A0-to-A1 and A0-to-A2 in one local rotation context are
instead a **domain conflict**. Both facts may have valid independent evidence.
They remain in positive history and produce the same conflict on every replica
that has them. Different IDs supporting A0-to-A1 again add provenance without
creating a competing successor or authorizing another notification.

Neither kind of conflict is cleared by replaying one preferred value or by
omitting the other from a later transfer. Branch reconciliation and repairing
ambiguous identities require a separately specified operation; this draft
defines neither as an implicit consequence of merge.

### 5.5 Evidence, missing dependencies and projection

The merge helper operates on normalized facts satisfying the input evidence
contract. It is not an import verifier. A host integrating replica histories
must first retain the union of original source variants and their evidence,
then verify and project against that combined source snapshot. Material may
arrive separately, but the host must retain pending records for reevaluation.

Do not merge cached heads, confirmation Booleans or `verified` flags. Reuse a
verification cache only while its exact token, document, source bindings and
profile remain valid in the combined evidence. If a newly learned source
contradiction invalidates a prior projection, rebuild the normalized input;
blindly unioning yesterday's verified-fact caches does not meet this contract.
The retained source inventory and the currently usable projection are different
layers; only the retained inventory is required to grow by union.

An evidence-reference collision must preserve all conflicting source values
and prevent the affected sources from being treated as complete. The host
reports this as an integrity diagnostic and blocks operations depending on
that reference. If the contradiction has projected fact variants, pass all
variants to the core so it can report their identity conflict. Missing or
invalid raw sources that cannot be projected remain host diagnostics; their
absence from the core is never a positive completeness assertion.

Inside a fact snapshot, a missing referenced fact is unresolved. Another
replica may supply that exact dependency and permit a new result. Two different
receipts still cannot contribute separate halves of one complete witness.
Verification or binding failures do not become valid because another replica
reported success. Hosts preserve the minimal source and proof material needed
to reproduce validation; transport and evidence retention remain their duties.

Publish a model view from one complete projection of the selected merged
snapshot. An intermediate input prefix cannot authorize an operation merely
because the conflicting branch has not been projected yet. This requirement
does not claim that a replica can detect all evidence still unknown to it.

### 5.6 Convergence and operation boundaries

The fact union is commutative, associative and idempotent. Deterministic
derivation over the same fact variants and model profile gives strong
convergence of query results. Usable heads and paths need not grow monotonically:
more retained evidence may reveal conflict and remove previously usable support.
An identical conflict result is a converged state.

An integrated system can claim strong eventual consistency only when its hosts
also converge on source acceptance and evidence validation, relevant source
variants and material eventually reach every participating replica, and
validation and derivation terminate for finite supported inputs. The package
does not provide that dissemination or membership protocol. Equal metadata
tags alone do not establish equal evidence, verifier behavior or completeness.

Convergence provides no coordination for concurrent operations. Two offline
replicas may each allocate a different successor from A0 and send its proof
before learning the other's decision. Merge exposes the fork without undoing
those sends. A unique active writer or another operation-coordination mechanism
belongs to the host. Local locking alone does not coordinate remote replicas.
Merge itself creates no admission, ACK, notification, dispatch or replay action.

### 5.7 Replica-local history

The merged present does not reconstruct what each replica knew in the past.
Historical queries use a host-selected snapshot identified by that replica's
revision or another explicit evidence cut. Retain the verification/binding
state and profile needed for that interpretation, or retain the actual decision
and its supporting evidence when auditing an operation.

Event creation time, JWT `iat` and a source's early receipt time cannot backdate
knowledge gained through a later import or verification. A new merge creates a
new current view; it does not rewrite an earlier replica snapshot or recorded
admission. There is no global wall-clock ordering in this contract. The core
continues to evaluate the facts supplied for the chosen snapshot.

### 5.8 Existing vault integration

The current [vault import contract](vault-sqlite.md#import) retains the target
row on an event-ID content collision and reports the conflict. Accepted event
rows alone therefore cannot implement this proposal's preservation of all
variants. A conforming future adapter must durably retain and exchange the
conflicting source variants and their evidence, then expose ambiguity during
projection. A local-only diagnostic or target-selected row is insufficient.
This draft does not change current vault import behavior.

### 5.9 Acceptance cases

Future implementation checks must cover:

- The three merge laws and arbitrary delivery order/batching, including snapshots with identity conflicts and an empty compatible snapshot.
- Stable source/projection IDs across replicas and rebuilds; repeated carrier evidence adds no new successor, while independent receipt provenance remains distinct.
- Canonical equality with reordered object properties; malformed or unknown-version input is refused without a partial mutation.
- Same-ID variants arriving in either order or through a third replica; all variants and conflict results survive retransmission, with no target preference.
- Collision propagation through exact source references, observations and joins; independent support for an uncontested change remains usable, without predecessor fallback or hidden alternatives.
- Separate material arrival, pending dependencies and newly contradicted sources; cached verification results cannot conceal the merged evidence.
- Opposite-side rotations forming a supported join, concurrent same-side rotations producing conflict, and ending competing with rotation regardless of arrival order.
- Equal final views after hosts have the same accepted sources, evidence and profile, while preserving their different historical snapshots and recorded decisions.
- Merge and rebuild producing no external operation or dispatch, and demonstrating that a local lock cannot prevent independent replica decisions.

<a id="derivation"></a>

## 6. Derivation responsibilities

Derivation follows the evidence dependency direction:

1. **Input consistency.** Check pairs, successors, IDs and references under the [merge contract](#merge-contract). Retain same-ID variants and propagate their identity conflict; missing referenced facts remain unresolved.
2. **Positive closure.** Start with verified peer rotations and local rotations with independently confirmed predecessors, then compute the least closure of supported joins. Retain all independently supported branches. Endings remain terminal assertions scoped through opposite-side links, without an empty-endpoint edge.
3. **Contexts and conflicts.** Over the full positive closure, detect competing same-side successors, cycles, a local/peer identity collision, and ending competing with a successor of the same endpoint. Event time and JWT `iat` select no winner.
4. **Usable continuity.** Exclude conflict-affected derivations and recompute closure with exact source and confirmation support. Links and joins losing their required support provide no usable path. Usability here concerns continuity alone.

For a proof-bearing observation, positive support requires its own independently
verified transition. Usable support additionally requires that transition to
be unaffected by context conflict. A proof-free observation confirms only its
exact local recipient; it cannot restore usable continuation through a
conflicted context.

A local rotation's confirmation uses links already established without that
decision or its descendants. A0-to-A1 cannot supply its own A0 prerequisite,
and a ring of mutually waiting decisions establishes nothing. The host does
not pass a graph-derived `confirmed: true` back as independent input.

Positive topology and usable paths are separately queryable. The former serves
history and conservative host policy, such as propagating a block over known
successors. The latter supplies continuity prerequisites for operations. The
model neither stores blocks nor decides their policy.

<a id="outputs"></a>

## 7. Available information

| Query | Domain result | Boundary |
| --- | --- | --- |
| `head(channel)` | A unique usable forward pair, ending, or reason it cannot be derived | Does not establish key/route availability, absence of blocking or permission to send |
| `changes(channel, side)` | Replacements and endings in that side's context, with support; usable for supersession checks | Does not supersede every relationship sharing a DID |
| `path(from, to)` | A directed usable path preserving endpoint roles and its supporting facts | Does not prove message receipt or authorize an ACK by itself |
| `confirmation(localDid, peerDid)` | Whether that peer or a usable peer successor wrote to the exact local DID, with observations and paths | Confirms no other local address, wire ID or application admission |
| `history(channel)` | Positive links, joins, endings, contexts and provenance | Historical connectivity establishes neither current usability nor contact identity |
| `localDecisions(channel)` | Supplied local decisions and their status in the relevant peer context | Excludes saved decisions not yet projected; insufficient on its own for successor allocation |
| `conflicts()` / `status(factId)` | Identity-conflict variants, affected scope, supporting facts, missing dependencies and domain contradictions | Selects no winner, deletes no history and creates no repair operation |

Head results distinguish different conditions instead of returning one `null`:

```ts
type HeadResult =
  | { status: "head"; channel: Channel; support: FactId[] }
  | { status: "ended"; endings: FactId[] }
  | { status: "unresolved"; waiting: FactId[]; missing: FactId[] }
  | { status: "conflict"; facts: FactId[] }
  | { status: "no-evidence" };
```

A head may be the original pair when it is known and has no established forward
change. `no-evidence` means there are no facts or derivable history for the pair.
A known forward change without usable continuation does not fall back to the
old pair. A local decision waiting for confirmation is explicitly unresolved,
so the host cannot mistake it for an absence of a selected successor.

Model-level unresolved results describe reference or confirmation gaps visible
to the core. Material and proof-verification gaps remain separate diagnostics
outside that input. Every result may change with the next snapshot.

Queries preserve support rather than only a Boolean. If an agent additionally
requires an admitted confirmation observation, it must be able to inspect
alternative observations and their paths. Filtering all unadmitted facts out
of the graph could hide real rotation or conflict. Policy may choose qualifying
support, but cannot combine individually incomplete sources into one witness.

The same fact set produces the same semantic result regardless of enumeration
order or storage backend. Additional facts may expose conflict and invalidate
a previously usable head or path. Query authority is therefore not monotonic.
Complete snapshot derivation is sufficient initially; incremental indexing is
a later performance choice. The [merge contract](#merge-contract) defines the
scope of convergence and its host integration prerequisites.

<a id="examples"></a>

## 8. Concrete data flows

A and B below stand for validated canonical DIDs.

### Receiving a B0-to-B1 proof

The agent authenticates a receipt from B1 to A0 and supplies its token and issuer
evidence to the proof module. Successful verification and binding produce:

```ts
const facts: ContinuityFact[] = [
  {
    kind: "peer-transition", id: "p1",
    at: { localDid: "A0", peerDid: "B0" },
    change: { kind: "rotate", successor: "B1" }, receipt: "receipt-1",
  },
  {
    kind: "address-observed", id: "o1",
    at: { localDid: "A0", peerDid: "B1" },
    carriedTransition: "p1", receipt: "receipt-1",
  },
];

const continuity = deriveContinuity(facts);
const head = continuity.head({ localDid: "A0", peerDid: "B0" });
```

Absent other contradictions, the head is `C(A0,B1)`. Observation o1 establishes
that B1 knows A0 and, through p1, supports confirmation in the original B0
context. It does not affect `C(X0,B0)` without connecting local-only continuity
evidence. The agent separately decides whether to process or reply to the
original message.

### Both parties rotate

At `C(A0,B0)`, an independent observation confirms A0. Add a local A0-to-A1
decision and a peer B0-to-B1 transition:

```mermaid
flowchart LR
    C00["C(A0,B0)"] -->|local decision| C10["C(A1,B0)"]
    C00 -->|peer transition| C01["C(A0,B1)"]
    C10 -. join .-> C11["C(A1,B1)"]
    C01 -. join .-> C11
```

The model derives head `C(A1,B1)` with support from both sides. It fabricates no
receipt from B1 to A1, so **A1 is not confirmed by this join**. The agent uses
exact-address confirmation when deciding whether new packages must carry its
saved A0-to-A1 proof.

### Confirmation without from_prior

A later authenticated receipt from B1 to A1 carries no proof. The host adds:

```ts
{
  kind: "address-observed", id: "o2",
  at: { localDid: "A1", peerDid: "B1" },
  carriedTransition: null, receipt: "receipt-2",
}
```

Observation o2 now supports confirmation of A1. Its shape is the same for chat,
Ping or any other protocol. The agent can use the result when preparing a new
package; a changed query result does not rewrite an existing package.

### Repetition and competition

Multiple valid carriers of the same B0-to-B1 proof add support without adding
a different successor. An independently valid B0-to-B2 proof in the same context
creates a visible conflict. Receipt order, JWT time and contact preference
select neither B1 nor B2.

### Using results in an agent transaction

Under its operation lock or snapshot discipline, the agent combines head,
path and confirmation results with saved decisions, admission, denial,
resource availability and protocol rules. It saves any new facts and projects
a new snapshot. Derived query results do not become independent evidence.

The model carries no database revision. The host keeps validation and commit
on the same valid snapshot, or checks again when its version changes. This is
an integration contract for using the model.

<a id="ending"></a>

## 9. Relationship ending

[DIDComm v2.1 Ending a Relationship](https://identity.foundation/didcomm-messaging/spec/v2.1/#ending-a-relationship)
expresses ending by omitting `sub` from the `from_prior` JWT and omitting `from`
from its carrier. Absence is distinct from a null or empty-string subject. The
proof module recognizes the ending claim shape; the model represents it as
`change: { kind: "end" }` without creating `C(A,null)`.

**The package must define an explicit context-binding rule for received
endings.** Rotation can compare the subject to an authenticated current sender;
ending lacks that sender. A valid signature establishes the issuer's declaration,
without by itself proving a recipient-specific relationship scope. The standard's
basic ending form does not require a signed recipient or audience binding.
This leaves a profile design question when an issuer DID serves multiple
relationships.

The proof module must not bind an ending to every pair containing its issuer,
or accept an arbitrary caller-selected pair solely because the JWT verifies.
The supported profile still needs to define which retained receipt evidence,
DID usage constraints or mutually supported additional binding can establish
a scoped ending. The host supplies that evidence; the package owns its binding
checks. Adding graph fields cannot supply missing evidence.

Proposed model semantics, separate from the standard's wire representation:

- An ending is a terminal assertion for a side, endpoint and context, retaining the original pair and evidence. It neither deletes contacts, messages, DIDs or keys nor acts as a local block.
- A peer ending applies across the local-only context retaining that peer. A local ending applies symmetrically across the peer-only context. Unconnected relationships sharing a DID are unaffected.
- An ending competing with a successor for the same endpoint/context is a conflict, without a time-based winner. B0-to-B1 followed by B1 ending is ordinary forward history, not competition at one predecessor.
- If one side ends while the other rotates, the ending extends with the opposite-side context and supplies no continuing joined head. Two endings do not create an empty pair.
- An ending carrier supplies neither successor-address confirmation nor evidence that an application message was processed.

The types can accommodate ending now, but received-ending binding remains
unresolved. Recognizing and verifying its JWT form does not complete that
integration. Choosing to end locally, notifying the peer, handling delayed
messages and governing existing outbound dispatch remain agent operations.

<a id="extraction"></a>

## 10. Extraction from the existing implementation

| Existing location | Extraction direction |
| --- | --- |
| [`vault/src/fold/continuity.ts`](../../packages/vault/src/fold/continuity.ts) | Move graph, closure, joins, contexts, conflicts, head and confirmation into the model; expose `ackPath` as a general path query; leave `blocked` with its policy consumer |
| [`vault/src/fold/channels.ts`](../../packages/vault/src/fold/channels.ts) | Keep event reading, local key/entity evidence and document retrieval in the adapter; call package proof verification and binding, then project minimal facts with exact source dependencies |
| [`vault/src/from-prior.ts`](../../packages/vault/src/from-prior.ts) | Move parsing, claim validation, issuer authorization, signature verification and proof creation into the formal `from-prior` module; keep retained-document lookup and vault key ownership with the host |
| [`vault/src/fold/contacts.ts`](../../packages/vault/src/fold/contacts.ts) | Keep contact payloads, selections and preferences in their existing domain, consuming continuity queries |
| [`agent-core/src/rotate.ts`](../../packages/agent-core/src/rotate.ts), [`agent-core/src/receive/receipt.ts`](../../packages/agent-core/src/receive/receipt.ts) | Keep locking, envelope receipt, successor allocation, decision persistence and notifications in the agent; provide evidence and signing capability to package APIs |

Dependency direction is `agent/vault adapter -> continuity`, with the proof
module using shared domain types and JOSE/DID libraries. Shared validation or
encoding helpers must not pull vault or event-store runtime dependencies into
the package. Fact IDs impose no storage format. The host need not use event
sourcing, but must supply a consistent snapshot with traceable evidence.

First extract existing rotation verification, binding and derivation behavior
through the minimal inputs. Then settle received-ending context binding and
its agent flow. The initial objective is equivalent continuity results and
shared proof rules, before designing further command or transaction abstractions.

Implementation acceptance should cover malformed tokens, unsupported headers
or algorithms, unauthorized keys, wrong issuer documents, altered signed bytes,
carrier/subject mismatch, signer/request mismatch, and rotation/ending claim
shapes. Model cases include input permutations and rebuilding, multiple
carriers, independent contexts, joins without fabricated confirmation,
proof-free confirmation, exact-source dependencies, missing references,
self-supporting or cyclic decisions, conflicting IDs, competing successors,
cycles and ending/rotation interactions. The merge contract adds replica union,
identity-conflict preservation and convergence cases. This draft adds no
runtime behavior.

<a id="open-questions"></a>

## 11. Remaining design questions

1. **Ending context binding.** Define a concrete interoperable acceptance rule before implementing received endings. This belongs to the package profile, with evidence supplied by the host.
2. **Support representation.** Preserve alternative observations and paths without expanding exponentially many paths. A traceable support graph is a candidate; the query API needs a prototype.
3. **Combined diagnostics.** Integrate core unresolved results with missing-material, verification and binding results so a temporary unique head is not mistaken for complete operation evidence.
4. **Signing capability.** Choose an interface that supports the host's non-exportable keys while keeping claim construction, authorization checks and returned-proof validation in the package.
5. **Vault conflict retention.** Design storage and interchange for all colliding source variants before claiming that the existing vault adapter satisfies the merge contract.

<a id="references"></a>

## 12. References

- [Current channel and continuity model](channels.md#continuity): the rotation behavior baseline for extraction.
- [Current address and contact policy](relationships.md#what-it-is-for): the boundary between continuity and application policy.
- [Current vault import](vault-sqlite.md#import): existing event-ID collision handling and the adapter gap.
- [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html): canonical encoding for normalized fact equality.
- [DIDComm DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation): wire proofs and address confirmation.
- [DIDComm Ending a Relationship](https://identity.foundation/didcomm-messaging/spec/v2.1/#ending-a-relationship): the ending wire representation.
