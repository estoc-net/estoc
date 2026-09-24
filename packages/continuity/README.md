# @estoc/continuity

Continuity between oriented DID pairs: how a pair `C(localDid, peerDid)`
evolves under rotation and ending, which pair follows when both parties
rotate, whether the peer has learned a new local address, and where the
evidence contradicts itself. The package neither reads messages nor
decides what an agent may do with a result.

Two entry points keep proof processing apart from the pure model:

| Entry point | What it does | What it imports |
| --- | --- | --- |
| `@estoc/continuity` | Validates facts, merges snapshots by union, derives continuity queries | `canonicalize` only |
| `@estoc/continuity/from-prior` | Inspects, verifies, binds and creates DIDComm v2 `from_prior` proofs | `jose`, `@estoc/did-peer`, `@scure/base` |

The types and JSDoc of the two entry points define the API. This file
adds what the API cannot express: the evidence each fact must rest on,
the profile, and the host contract, which are binding on an integrator
too. The tests in the repository are the worked examples:
[`merge.test.ts`](https://github.com/estoc-net/estoc/blob/main/packages/continuity/test/merge.test.ts)
for the merge laws,
[`model.test.ts`](https://github.com/estoc-net/estoc/blob/main/packages/continuity/test/model.test.ts)
for what each query answers in each situation, and
[`from-prior.test.ts`](https://github.com/estoc-net/estoc/blob/main/packages/continuity/test/from-prior.test.ts)
for verifying, binding and creating proofs with a host-held key.

The repository's [illustrated guide](docs/guide.md) walks through joins,
confirmation, contexts, conflicts, endings and proof boundaries, with
diagrams and links to the corresponding tests.

## Where it sits

```
host: receipts, envelopes, saved decisions, retained documents, keys
  │  verifyFromPrior + bindFromPrior          ← @estoc/continuity/from-prior
  ▼
continuity facts, one snapshot per local identity
  │  mergeFacts across replicas, deriveContinuity
  ▼
head, path, confirmation, history, conflicts   ← @estoc/continuity
  │
  ▼
host: admission, dispatch, contact policy, successor allocation
```

| Question | This package | The host |
| --- | --- | --- |
| Is this a valid rotation or ending proof? | Parses the JWT, checks the profile, takes the key from the issuer's own document, verifies the signature | Retains the issuer's long-form DID and the original token |
| Which pair does this receipt establish? | Binds the verified proof to the recipient and sender the host established | Decrypts and authenticates the envelope |
| Did B0 become B1 here? Which pair follows both rotating? | Derives links, joins, contexts and a unique head | Uses the answer under its own policy |
| Does the peer know A1? | Derives confirmation from exact address observations | Supplies authenticated observations |
| Does the evidence conflict? | Keeps every branch and reports the scope; picks no winner | Shows diagnostics, gathers more evidence |
| May this message be processed, replied to, acknowledged? | A directed path preserving roles, with its support | Admission, ACK targets, threads, user policy |
| Can the next operation be sent? | Nothing: there is no `canSend` | Keys, routes, locking, commits, dispatch |

## Facts

The model consumes three kinds of fact, each with a host-allocated `id`
that is stable across replicas and rebuilds, and an evidence reference
the host can map back to the original record. The types in
`src/types.ts` say exactly what each member means.

- `peer-transition` — the peer of `at` rotated to `successor`, or ended,
  as a verified and bound proof established.
- `local-decision` — a saved choice to rotate the local DID of `at`, or
  to end there; `source` optionally names the exact observation that
  confirms the predecessor address, and null lets the model find any.
- `address-observed` — one authenticated receipt from the peer of `at`
  to exactly its local DID; `carriedTransition` names the transition the
  same receipt carried, or is null when it carried no proof.

A fact is admitted only in the exact shape of its kind: no extra
members, explicit nulls, distinct endpoints, a successor that is neither
endpoint. DIDs are compared byte for byte and never parsed, so the host
passes canonical DIDs. Equality is the RFC 8785 text of the validated
fact; `canonicalFact` produces it.

Each kind rests on evidence only the host can establish:

- A peer transition is a proof that verified and bound under the
  profile, at the pair the receipt established. Proof-free claims are
  not transitions.
- A local decision is a choice the host saved before acting on it. A
  named `source` is exact: no other observation stands in for it, and a
  source addressed to another local DID makes the decision invalid.
- An observation is one authenticated envelope to exactly that local
  DID from that peer. A carried transition must be of the same receipt,
  a rotation, received by the same local DID and naming the observed
  peer as successor; anything else makes the observation invalid.

## Merge

```ts
import { mergeFacts, deriveContinuity } from "@estoc/continuity";

const merged = mergeFacts(left, right);
const model = deriveContinuity(merged.facts);
```

A snapshot maps each fact ID to the set of distinct values seen under
it. `mergeFacts` is the union by ID, so it is commutative, associative
and idempotent, with `emptySnapshot` as identity; delivery order and
batching do not change the result. The result enumerates IDs and then
canonical texts in UTF-8 byte order, so two replicas holding the same
facts produce the same snapshot. Two values under one ID are retained as
an identity conflict, never chosen between. A different
`identityNamespace` or a `profileVersion` this package does not
implement is refused with `IncompatibleSnapshot` before anything is
produced; a malformed fact anywhere is refused with `InvalidFact`.

## Queries

`deriveContinuity(facts)` builds the model in the order the evidence
depends on itself:

1. **References.** Each fact's exact references are resolved. A missing
   one leaves the fact `unresolved`; one whose ID has several values
   makes it `conflict`; one of the wrong kind or pair makes it
   `invalid`.
2. **Positive graph.** Every peer rotation, every local rotation whose
   predecessor address an observation confirms, and every join two
   rotations imply, all branches kept. Every variant of a repeated ID
   enters when its own prerequisites hold, so the competition it creates
   is visible; no variant links or witnesses anything usable.
3. **Contexts and conflicts** over that whole graph. A peer change's
   context is the set of pairs local-only links connect while keeping
   that peer; a local change's context is the symmetric one. The
   conflicts are competing changes of one endpoint in one context,
   cycles, joins that would pair a DID with itself, and repeated IDs
   with different values. Every saved local decision counts toward
   competition whether or not it is confirmed yet: two saved successors
   of one predecessor are a fork either way. A conflict's scope is its
   context and the successors the claims in that context name.
4. **Usable graph.** The same closure again over unambiguous facts,
   admitting no channel a conflict reaches. The positive graph says what
   replacements the evidence shows; the usable graph says which of them
   an operation may rely on.

Nothing reads arrival order, event time or JWT `iat`; the same facts
give the same answers from any enumeration order or storage.

### What the answers mean

`head(channel)` answers, in order of precedence: `conflict` when a
conflict reaches the pair, `ended` when an unambiguous ending applies to
it, `unresolved` while saved rotations of the endpoint wait for their
evidence, then `head` with the unique usable forward pair and the
support of the usable links that lead there. A pair only a waiting
decision names as its successor is `unresolved`; `no-evidence` is for a pair no fact mentions.
A known forward change without usable continuation never falls back to
the old pair.

Three rules decide the hard cases. **Independent support wins over a
collided twin:** a collided or waiting claim of a change that independent
unambiguous facts establish anyway is provenance, not an obstacle, when
the same change is made by a usable link at any pair of the usable
context, or the same side's ending is made unambiguously in that
context. **Authority stops at usable links:** a claim at a pair that
only diagnostic history connects to the query, such as an ending beyond
a collided rotation, may or may not apply to it and is `conflict`,
never applied. **Every saved rotation of the endpoint is answered for**
across the pair's whole positive context, including pairs off the usable
forward paths: one the same usable change covers is provenance, one at a
pair usable links connect is `unresolved`, one only diagnostic history
connects is `conflict`. A pending choice is diagnosed along its whole
reference chain, as `status` diagnoses it: a missing carried transition
of its source is listed as missing, and a collided one is a conflict
that outranks an ending.

`changes(channel, side)` lists that side's changes across the channel's
context with each fact's status. `path(from, to)` gives one directed
usable path preserving roles. `confirmation(localDid, peerDid)` lists
the usable observations by which the peer, or a usable successor of it,
wrote to exactly that local DID, each with one complete witness.
`history(channel)` shows every positive link connected to the channel,
joins marked, the endings in scope and both contexts. `localDecisions`,
`conflicts` and `status` expose what the others summarize. Each result
type in `src/model.ts` documents its variants.

Support re-derives the usable links an answer asserts, or one
confirmation, under the same profile. It is not a snapshot that replays
the whole answer: an unchanged head or a zero-step path has empty
support, and neither establishes an address observation or a rotation;
the ending IDs an `ended` answer lists are the assertions, not the
context that scopes them. No support proves the absence of a conflict or
a missing reference outside the snapshot. Keep the snapshot, not the
support, to replay a result.

### Endings

An ending is a terminal assertion for one side in one context. A peer
ending applies across the local-only context that keeps the peer; a
local ending applies symmetrically across the peer-only context; pairs
that merely share a DID are untouched. An ending and a rotation of the
same endpoint in one context compete, with no time-based winner; a
rotation followed by the successor ending is ordinary forward history.
When one side ends while the other rotates, the ending extends across
the opposite-side context and supplies no joined head. Two endings do
not create an empty pair. An ending carrier confirms no address.

## from_prior

```ts
import { verifyFromPrior, bindFromPrior, createFromPrior } from "@estoc/continuity/from-prior";

const proof = await verifyFromPrior(jwt, { ref: "doc-1", longForm: issuerLongForm });
const binding = bindFromPrior(proof, { ref: "receipt-1", token: jwt, recipient, sender }, { transitionId: "p1", observationId: "o1" });
if (binding.status === "bound") facts.push(...binding.facts);
```

The supported profile, `FROM_PRIOR_PROFILE`, is did:peer:4 issuers,
subjects and audiences, `EdDSA` over Ed25519 authentication keys, an
integer `iat` and no `exp` or `nbf`: the profile evaluates no validity
window, and verification consults no clock. Creation writes
`typ: JWT`; reception takes `typ` as the optional media type it is,
accepting its absence or `JWT` and `application/jwt` in any case. A
`b64` header, when present, is `true` and listed in `crit`, as
RFC 7797 requires of a JWT. DID equivalence is the did:peer:4 short
form; presented spellings are kept beside it. The issuer evidence is
the issuer's long-form DID as the host retained it: a did:peer:4 is its
own document, so the signing key is taken from the content the DID's
hash covers and a document assembled by a caller cannot substitute one.
The module resolves nothing over the network. `InvalidFromPrior.failure`
tells form, profile, document and signature failures apart.

`inspectFromPrior` decodes a token without verifying it, so the host can
find the issuer's material. `verifyFromPrior` establishes the issuer's
declaration. `bindFromPrior` turns it into facts at the pair the
receipt established: a rotation requires the receipt's own token and an
authenticated sender equal to `sub`, and yields the peer transition at
`C(recipient, iss)` and, when an observation ID is given, the address
observation at `C(recipient, sub)` under the same receipt reference. A
wrong token, sender or recipient is a `mismatch`.

A received ending has no sender, and the standard's basic form binds it
to no particular relationship: a valid token could be replayed in a new
anonymous envelope to another recipient, and decryption alone does not
bind the declaration to that second relationship. This profile binds an
ending only when its JWT names the recipient in `aud` and the receipt is
anonymous, which the host asserts by a null sender only when the
plaintext carried no `from`. An ending in the basic form verifies but
reports `unbound`, so endings from agents that do not add `aud` are
retained without binding. The signed audience is this profile's
extension, not a DIDComm requirement.

`createFromPrior` builds the token from a request and a signing
capability that names its method and signs the JWS signing input, so a
key behind a hardware wallet can sign, then verifies the result against
the issuer evidence before returning it. Creating a proof saves and
sends nothing.

## Host contract

The model checks structure, references and graph semantics. Everything
below is the host's, and the model cannot check it.

- **Evidence.** The host verifies source acceptance, endpoint ownership
  and envelope authentication, and retains stable fact IDs, evidence
  references, the original tokens and documents, and every conflicting
  source variant. The model cannot reconstruct evidence an untrusted
  caller omitted, and a branded verified type is a guard against
  accidental misuse, not a security boundary for imported data.
- **Completeness.** Every answer is relative to the snapshot supplied.
  The model cannot say that unknown history does not exist, and it does
  not see sources awaiting material, verification or binding; the host
  combines the model's diagnostics with its own. A temporary unique
  head does not satisfy an operation's missing exact prerequisites.
- **Projection.** The retained source inventory and the usable
  projection are different layers; only the inventory grows by union.
  `mergeFacts` merges normalized facts, not verification caches: a
  newly learned source contradiction may require re-verifying and
  rebuilding the projection, and a verification cache is reused only
  while its exact token, document, bindings and profile still hold in
  the combined evidence. A colliding evidence reference keeps every
  value and blocks the operations that depend on it; when the collision
  projects to fact variants, pass them all so the model reports the
  identity conflict.
- **One complete snapshot.** Publish a model view from one complete
  projection of the selected snapshot; a prefix cannot authorize an
  operation because the conflicting branch is not projected yet. Two
  receipts cannot contribute halves of one witness, and a verification
  failure does not become success because another replica reported
  success.
- **Same revision.** Evaluate an operation's continuity prerequisites
  and commit its state against the same valid revision of the sources
  and their projection. When that revision changes before the commit,
  derive again and evaluate again on the new snapshot; a transaction, a
  lock or an optimistic version check are all ways to do it. The model
  carries no database revision and validates nothing at commit time.
- **History.** The merged present does not reconstruct what a replica
  knew before. A historical question uses the snapshot that replica
  held then, with the verification state and profile of that time;
  filtering today's facts by `iat` or receipt time backdates nothing.
- **Authority.** Head, path and confirmation are continuity
  prerequisites, not permission: they establish neither key and route
  availability, nor the absence of a block, nor that a message was
  processed. Derived results are not fed back as facts. Before
  allocating a successor the host inspects all saved decisions,
  including ones it has not projected; an empty `localDecisions` does
  not clear the allocation.
- **Coordination.** Merge converges; it does not coordinate. Two
  offline replicas can each allocate a successor from the same pair and
  send its proof, and merge then exposes the fork without undoing the
  sends. A unique active writer or another coordination mechanism is
  the host's; a local lock alone coordinates no remote replica. Merge
  creates no admission, ACK, notification or dispatch action.
- **Profile.** `PROFILE_VERSION` and `FROM_PRIOR_PROFILE` cover the fact
  schema, normalization, proof acceptance and derivation together. A
  change to what any of them means is a new profile string with a
  migration, never the same string with new behavior.

## Limits

- Endings bind only through this profile's signed audience; a basic
  ending is verified and retained `unbound`, never applied.
- `path` returns one deterministic path. `confirmation` lists every
  eligible observation, but with one deterministic witness each:
  alternative paths to the same observation are not enumerated. A
  policy that needs exhaustive routes needs a richer query; filtering
  facts out of the input to search for a preferred result can hide a
  rotation or a conflict.
- The proof profile refuses `exp` and `nbf`. Supporting them needs an
  explicit evaluation time and a rule for evidence accepted earlier.
- Usable heads and paths are not monotonic: more evidence can expose a
  conflict and withdraw an answer. A converged conflict is a converged
  state.
- The vault does not consume this package yet, and its import keeps one
  row per event ID on a content collision, which cannot carry every
  variant this merge contract retains. A conforming adapter must retain
  and exchange the colliding variants first.

## References

- [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html): fact equality.
- [DIDComm v2.1 DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation) and [Ending a Relationship](https://identity.foundation/didcomm-messaging/spec/v2.1/#ending-a-relationship): the wire proof.
- [Peer DID method 4](https://identity.foundation/peer-did-method-spec/#method-4-short-form-and-long-form): short and long forms.
- [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html) and [RFC 7797](https://www.rfc-editor.org/rfc/rfc7797.html#section-1): the JWT and its encoded payload.
