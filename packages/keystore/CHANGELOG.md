# @estoc/keystore

## 0.3.0 — 2026-08-17

Seed keystore v3: keys are derived by **name**, not by index.

- HKDF info label is `estoc/v3/<purpose>/<name>` (was `estoc/v1/<purpose>/<index>`).
  Every derived DID changes; there is no migration from v2 documents, which
  `parseSeedKeystore` now refuses with a clear message. v1 (per-key JWE)
  documents are unaffected.
- `SeedKeystoreDocument` is `{version: 3, seedJwe, keys}` — no `nextIndex`,
  entries are `{name, did, createdAt}` with no `index`. `keys[]` is a cache,
  not an allocation table.
- `deriveIdentity(seedKey, name)` replaces `deriveIdentity(seedKey, index)`;
  `DerivedIdentity.name` replaces `.index`. Names must match
  `[A-Za-z0-9._/-]+` (`isValidKeyName`, `KEY_NAME_PATTERN` exported).
- `addDerivedKey` is idempotent by name; `openDerivedKey` derives whether or
  not the name is listed (and checks the DID when it is); `removeDerivedKey`
  forgets the listing only.
- `parseSeedKeystore` keeps unknown fields.

## 0.2.0 — 2026-08-15

Seed keystore v2: one sealed seed, index-derived Ed25519/X25519 identities,
non-extractable `SeedKey`.

## 0.1.0

Per-key PBES2 JWE keystore (v1) and the `Signer` / `DidKeySigner` handles.
