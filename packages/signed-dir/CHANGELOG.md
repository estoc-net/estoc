# @estoc/signed-dir

## 0.2.0 — 2026-08-21

Takedown cards, per public-folder/1.0: `RootCard.root` is now nullable
(`string | null`, still required).

- A card with `root: null` asserts "I publish nothing" — the takedown
  form. `createCard` signs it as-is; `verifyCard` returns it with
  `root: null`.
- Null is the **only** encoding: a payload *missing* the `root` field
  (or carrying a non-string, non-null value) is rejected as a malformed
  root card. A takedown is destructive, so it must be written
  deliberately — a producer bug that drops a field must not mint a
  valid takedown card (RFC 7386's null-means-removal idiom, DID Core's
  explicit `deactivated`). Verifiers need a single check:
  `card.root === null`.

## 0.1.0 — 2026-08-19

Initial release: IPLD-notation merkle hashing (raw file CIDs + dag-json
directory nodes) — `hashTree` / `verifyTree` / `resolvePath` — and the
signed root card (`createCard` / `verifyCard`, compact JWS EdDSA verified
with zero-dependency WebCrypto). Pure functions, no IO.
