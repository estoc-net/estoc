# Changelog

## 0.2.0 — 2026-08-24

- Moved into the `estoc` monorepo (`packages/cli`); workspace deps.
- **Breaking:** keystore v3 — one seed sealed under one passphrase, keys
  derived by name. `estoc init` mints `anchor` (not `default`) and writes
  `config.identity.anchor` plus `mediation: null` per docs/vault-format.md.
  Vaults made by 0.1.0 (keystore v1) are refused, not migrated.
- `estoc object hash|sign|verify|bundle` — the former `estoc-object` tool
  from `@estoc/folder-object`, now signing with vault keys.
- `ESTOC_PASSPHRASE` answers passphrase prompts.

## 0.1.0

- `estoc init`, `status`, `key list`, `key new` over a `.estoc` directory.
