# @estoc/keystore

## 0.4.0 — 2026-09-20

- **The store lists no keys.** `SeedKeystoreDocument` is `{ version: 3,
  seedJwe }`; `keys[]`, `DerivedKeyEntry`, `addDerivedKey`,
  `openDerivedKey`, `removeDerivedKey` and `listKeys` are removed. A name
  derives its key with `deriveIdentity(seedKey, name)`, and which names
  are in use is the vault's events' to say. `parseSeedKeystore` refuses a
  document that carries `keys`. The derivation itself is unchanged: the
  same seed and name give the same Ed25519 and X25519 keys as 0.3.0.

## 0.3.0 — 2026-08-17

Seed keystore v3: keys are derived by **name**, not by index. One store,
one format.

- HKDF info label is `estoc/v3/<purpose>/<name>` (was `estoc/v1/<purpose>/<index>`).
  Every derived DID changes; there is no migration from v2 documents, which
  `parseSeedKeystore` now refuses with a clear message.
- **The v1 per-key store is gone**: `emptyKeystore`, `createKey`, `openKey`,
  `removeKey`, `parseKeystore`, `didKeySignerFromPrivateKey`,
  `generatePrivateKey`, `KeystoreDocument`, `KeyEntry`, `KeyInfo` are
  removed; `parseSeedKeystore` refuses `version: 1` too. `listKeys` and
  `serializeKeystore` take the seed store only. `Signer` / `DidKeySigner`
  stay — they are what a derived identity hands out.
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
