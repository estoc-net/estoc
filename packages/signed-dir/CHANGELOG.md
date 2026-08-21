# @estoc/signed-dir

## 0.2.0 — 2026-08-21

Takedown cards, per public-folder/1.0: `RootCard.root` is now OPTIONAL.

- A card without `root` asserts "I publish nothing" — the takedown form.
  `createCard` signs it as-is (the absent field stays absent on the wire);
  `verifyCard` returns it without a `root` key.
- Absence is the **only** encoding: a payload carrying `"root": null` (or
  any non-string) is rejected as a malformed root card, so exactly one
  byte sequence says takedown and relays/readers need a single check
  (`card.root === undefined`).

## 0.1.0 — 2026-08-19

Initial release: IPLD-notation merkle hashing (raw file CIDs + dag-json
directory nodes) — `hashTree` / `verifyTree` / `resolvePath` — and the
signed root card (`createCard` / `verifyCard`, compact JWS EdDSA verified
with zero-dependency WebCrypto). Pure functions, no IO.
