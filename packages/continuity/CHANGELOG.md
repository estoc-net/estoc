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
An ending names no source.
