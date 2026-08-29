# Changelog

## Unreleased

- The vault is read and written through `@estoc/vault` (`Vault` over
  `FsBackend` from `@estoc/vault/node`) instead of a second implementation
  of the format here. Same files, same modes (`.estoc` 0700, the keystore
  0600 — kept across rewrites now), same commands; `writeKeystore` is gone
  from the exports.
## 0.3.0 — 2026-08-26

- `estoc object render [<dir|zip>] [--template <html>] [--out <file>]
  [--asset-base <prefix>]` — project a post/1.0 object (`@estoc/post`):
  vocabulary, body fragment, assets, files, root and signer as JSON, or
  laid into a Mustache-subset template (`{{key}}` escaped, `{{{key}}}`
  raw, `{{#key}}…{{/key}}`, `{{^key}}…{{/key}}`, `{{.}}`). The renderer
  is the app's; the page is the host's.

## 0.2.0 — 2026-08-24

- Moved into the `estoc` monorepo (`packages/cli`); workspace deps.
- **Breaking:** keystore v3 — one seed sealed under one passphrase, keys
  derived by name. `estoc init` mints `anchor` (not `default`) and writes
  `config.identity.anchor` plus `mediation: null` per docs/vault-format.md.
  Vaults made by 0.1.0 (keystore v1) are refused, not migrated.
- `estoc object hash|sign|verify` — the former `estoc-object` tool from
  `@estoc/folder-object`, now signing with vault keys. `sign` prints the
  card, or with `--out <dir>` / `--zip <file>` lays the signed object
  (`object/` + `card.jws`) out beside whatever else is in the directory;
  there is no separate `bundle` step.
- `ESTOC_PASSPHRASE` answers passphrase prompts.

## 0.1.0

- `estoc init`, `status`, `key list`, `key new` over a `.estoc` directory.
