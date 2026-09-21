# Changelog

## Unreleased

- The libraries are imported from their roots: `@estoc/daemon`,
  `@estoc/daemon/node`, `@estoc/agent-core`, `@estoc/event-store`,
  `@estoc/vault`, the `./v3` entries being gone.
- **The vault is version 3**: `estoc init` makes `.estoc/vault.sqlite` as
  the daemon's Node host keeps it (`@estoc/daemon/v3/node`), with the
  seed sealed inside it and the label as its first `identity.label`, and
  `estoc serve` runs the version-3 daemon on it. A `.estoc` of the
  folder format is refused by every command and nothing is written
  beside it.
- **One process has the folder at a time.** A command takes the folder
  the way a daemon does and lets go when it ends. Where a daemon holds
  it, `init` and `status` ask that daemon at the socket it left word of
  in `.estoc/daemon.url`: `init` has it make the vault, `status` shows
  its phase and, of an open vault, the label and the anchor. `object
  sign` is refused there: the seed stays in the process that unlocked
  it.
- **`estoc key list` and `estoc key new` are gone.** The vault keeps no
  list of key names; `object sign --key <name>` derives the key of that
  name as before. `readConfig`, `readKeystore`, `createVaultKey`,
  `VaultConfig` and `KeyRef` leave the library with them; `vaultStatus`
  is what `status` reads.
- **A `.estoc` that stood open to others is closed to 0700** by every
  command that takes the folder, before anything is written into it.
- **`object render --template` is rendered by `mustache`.** An escaped
  tag now also escapes `'`, so a value stays inside an attribute quoted
  either way; `/`, `` ` `` and `=` come out as entities too, and an
  array under `{{key}}` joins with `,`. The help names the body's key as
  it is, `{{{bodyHtml}}}`.
- Node 22.13 is the oldest that runs it, which is what `node:sqlite`
  needs.

## 0.5.0 — 2026-09-01

- The vault `estoc init` writes and `estoc serve` opens is version 2
  (`docs/vault-folder.md`, `docs/vault-events.md`): `initVault` is
  `createFolderVault` from `@estoc/vault` over `FsBackend` from
  `@estoc/event-store/node`, plus the label as the first `identity.label`
  event; `readConfig` checks the v2 `config.json` and folds the label;
  `readKeystore` reads `keystore.json` as it is; `openVaultKey` /
  `createVaultKey` go through `openFolderVault` (anchor checked) and the
  keystore cache. `VaultConfig` is `{ format, version: 2, label,
  identity.anchor }`; a version-1 config is refused ("version 1 is not
  2") and nothing else of the folder is read. `.estoc` 0700 and the
  keystore 0600 as before.

## 0.4.0 — 2026-08-29

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
