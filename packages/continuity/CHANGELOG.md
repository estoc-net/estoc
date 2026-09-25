# Changelog

## 0.1.0 — Unreleased

The continuity domain: a pure model of oriented DID pairs under rotation
and ending, and a `from-prior` module for DIDComm v2 proofs.

- `@estoc/continuity`: three fact kinds with exact evidence references,
  RFC 8785 equality, a union merge of snapshots that retains every
  variant of a repeated ID, and deterministic queries for head, changes,
  path, confirmation, history, local decisions, conflicts and fact
  status. Conflicts are reported with their scope and never resolved;
  independent unambiguous support keeps a change usable beside a
  collided claim of it; authority stops at usable links.
- `@estoc/continuity/from-prior`: inspection, precheck, verification,
  binding and creation of `from_prior` under the `estoc-from-prior/1`
  profile: did:peer:4 parties, Ed25519, no validity window, no clock.
  The precheck applies the document-independent rules verification
  applies, and refuses a rotation whose successor is not the
  authenticated sender, before the host has issuer material; its result
  stays unverified. The signing key comes from the issuer's own long
  form. Endings bind only through a signed audience on an anonymous
  receipt; the basic form verifies and stays unbound.

The package README is the reading entry; the vault does not consume the
package yet.
