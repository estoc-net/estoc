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

## Facts

The model consumes three kinds of fact, each with a host-allocated
`id` that is stable across replicas and rebuilds, and an evidence
reference the host can map back to the original record:

- `peer-transition` — the peer of `at` rotated to `successor`, or ended,
  as a verified and bound proof established.
- `local-decision` — a saved choice to rotate the local DID of `at`, or
  to end there; `source` optionally names the exact observation that
  confirms the predecessor address.
- `address-observed` — one authenticated receipt from the peer of `at`
  to exactly its local DID; `carriedTransition` names the transition
  the same receipt carried, or is null when it carried no proof.

A fact is admitted only in the exact shape of its kind: no extra
members, explicit nulls, distinct endpoints, a successor that is
neither endpoint. Equality is the RFC 8785 text of the validated fact.

## Merge

```ts
import { mergeFacts, deriveContinuity } from "@estoc/continuity";

const merged = mergeFacts(left, right);
const model = deriveContinuity(merged.facts);
```

A snapshot maps each fact ID to the set of distinct values seen under
it; `mergeFacts` is the union by ID, so it is commutative, associative
and idempotent, and enumerates the result by ID and then by canonical
text in UTF-8 byte order. Two values under one ID are retained as an
identity conflict, never chosen between. A different namespace or a
profile version this package does not implement is refused before
anything is produced.

## Queries

`deriveContinuity(facts)` derives, in order: every fact's references;
the positive closure of peer rotations, confirmed local rotations and
their joins, every branch kept; contexts and conflicts over that whole
graph; and the usable closure, which admits no ambiguous fact and no
channel a conflict reaches. Queries:

- `head(channel)` — `head` with the unique usable forward pair and its
  support, `ended`, `unresolved` with the waiting decisions and missing
  references, `conflict` with the facts involved, or `no-evidence`. A
  known forward change without usable continuation never falls back to
  the old pair. Conflict reaching the pair outranks an ending, an ending
  outranks waiting decisions, and a pair that only a waiting decision
  names as its successor is `unresolved`; `no-evidence` is for a pair no
  fact mentions.
- `changes(channel, side)` — the changes of that side's endpoint across
  its context, with each fact's status.
- `path(from, to)` — a directed usable path preserving roles.
- `confirmation(localDid, peerDid)` — the usable observations by which
  the peer, or a usable successor of it, wrote to exactly that local
  DID, each with one complete supporting path: the facts listed
  re-derive the confirmation on their own, but alternative paths to the
  same observation are not enumerated.
- `history(channel)` — every positive link connected to the channel,
  derived joins marked, the endings in scope and both contexts.
- `localDecisions(channel)`, `conflicts()`, `status(factId)`.

A peer change's context is the set of pairs local-only links connect
while keeping that peer; a local change's context is the symmetric one.
Competing changes of one endpoint in one context, cycles, joins that
would pair a DID with itself, and repeated IDs with different values
are the conflicts. Every saved local decision counts toward competition
whether or not it is confirmed yet, since two saved successors of one
predecessor are a fork either way. Every variant of a repeated ID enters
the positive graph when its own prerequisites hold, so the competition
it creates is visible, but no variant links or witnesses anything usable.
A conflict's scope is its context and the successors the claims in that
context name; a variant of the same ID claiming something in another
context is a different claim and stays out of it. A collided or waiting
claim of a change that independent unambiguous facts establish anyway
does not block the head: the same change made by a usable link at any
pair of the usable context, or the same side's ending in that context by
an unambiguous ending, is the head, and the collision stays a diagnostic
on that fact. Authority stops at usable links: a claim at a pair that
only diagnostic history connects to the query, such as an ending beyond
a collided rotation, may or may not apply to it and is reported as
`conflict`, never applied. Saved rotations of the head's endpoint are
answered for across its whole positive context, including pairs off the
usable forward paths: one the same usable change covers is provenance,
one at a pair usable links connect is `unresolved`, and one only
diagnostic history connects is `conflict`.

## from_prior

```ts
import { verifyFromPrior, bindFromPrior, createFromPrior } from "@estoc/continuity/from-prior";

const proof = await verifyFromPrior(jwt, { ref: "doc-1", longForm: issuerLongForm });
const binding = bindFromPrior(proof, { ref: "receipt-1", token: jwt, recipient, sender }, { transitionId: "p1", observationId: "o1" });
if (binding.status === "bound") facts.push(...binding.facts);
```

The supported profile is did:peer:4 issuers, subjects and audiences,
`EdDSA` over Ed25519 authentication keys, an integer `iat` and no
`exp` or `nbf`: the profile evaluates no validity window, and
verification consults no clock. Creation writes `typ: JWT`; reception
takes `typ` as the optional media type it is, accepting its absence or
`JWT` and `application/jwt` in any case. A `b64` header, when present,
is `true` and listed in `crit`, as RFC 7797 requires of a JWT. DID
equivalence is the did:peer:4 short
form; presented spellings are kept beside it. The issuer evidence is the
issuer's long-form DID as the host retained it: a did:peer:4 is its own
document, so the signing key is taken from the content the DID's hash
covers and a document assembled by a caller cannot substitute one. The
module resolves nothing over the network.

Binding a rotation requires the receipt's own token and an
authenticated sender equal to `sub`; it yields the peer transition at
`C(recipient, iss)` and, when an observation ID is given, the address
observation at `C(recipient, sub)` under the same receipt reference.

A received ending has no sender, and the standard's basic form binds it
to no particular relationship. This profile binds an ending only when
its JWT names the recipient in `aud` and the receipt is anonymous, which
the host asserts by a null sender only when the plaintext carried no
`from`; an ending in the standard's basic form verifies but reports
`unbound`, so endings from agents that do not add `aud` are retained
without binding.

`createFromPrior` builds the token from a request and a signing
capability that names its method and signs the JWS signing input, then
verifies the result against the issuer evidence before returning it.
Creating a proof saves and sends nothing.
