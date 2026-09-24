# Changelog

## 0.1.0 — Unreleased

First cut of the continuity domain: the pure fact model with its merge
contract and queries, and the from-prior proof module under the
did:peer:4 + Ed25519 profile. Not yet consumed by the vault.

Issuer evidence is the retained long-form did:peer:4; the signing key
comes from the content its hash covers. Verification leaves only the
JWS to the library and consults no clock. A confirmation's support
includes the peer path to the observer. A collided local decision, a
fork's successor pair and a pair only conflicted links lead to answer
`conflict`; a pair only a waiting decision names answers `unresolved`.
An ending names no source. A collided or waiting claim of a change
that independent facts establish usably does not block the head; a
fork's scope follows the claims made in its context, not every variant
of an ID involved. Path searches keep one parent edge per channel and
rebuild a path on demand. Reception takes `typ` as optional. The same
change made usably at any pair of the usable context covers a collided
or waiting claim of it; an ending at another pair applies only through
usable opposite-side links, and one reached only through diagnostic
history answers `conflict`. A `b64` header is `true` and critical.
A saved rotation of the head's endpoint anywhere in its positive
context is answered for: covered by the same usable change, pending
when usable links connect its pair, otherwise `conflict`. A pending
choice is diagnosed along its whole reference chain, as its status is.
