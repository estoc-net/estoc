# @estoc/cli

`estoc` — the command-line client for Estoc vaults.

A vault is any folder you own with a `.estoc` directory inside. The model
is git's: **the folder holds your content, `.estoc` holds the machinery** —
one seed sealed under a passphrase ([`@estoc/keystore`](../keystore) v3),
from which every key is derived by name. `estoc init` never touches your
files; it only adds `.estoc`. Commands discover the enclosing vault by
walking upward from the working directory, exactly like git finds its
repository. The layout is [docs/vault-format.md](../../docs/vault-format.md);
the app writes the same `.estoc` into the browser's private file system.

```sh
cd ~/my-vault
estoc init                   # prompts for a passphrase; seals a seed, mints the anchor key
estoc status                 # vault path, label, anchor, keys — no passphrase needed
estoc key list               # the same keys as JSON, for pipelines
estoc key new org/estoc      # derive another key by name (same seed, same passphrase)
```

Folder-objects ([`@estoc/folder-object`](../folder-object)) are signed
with vault keys:

```sh
estoc object hash   posts/hello/object                       # root CID of the canonical tree
estoc object sign   posts/hello/object --key org/estoc        # prints the card
estoc object sign   posts/hello/object --key org/estoc --out posts/hello --zip hello.zip
                                                             # posts/hello/{object/, card.jws} + a zip of the same
estoc object verify posts/hello                              # or hello.zip, or a bare object dir
```

A signed object is `{object/, card.jws}`; anything else in the directory
(a rendered page, the zip) is not part of it and is left alone.

`sign` defaults to the vault's `anchor` key. Every command that unlocks the
seed first re-derives the anchor and compares it with `config.json` — a
seed that does not derive the recorded anchor is the wrong seed for this
vault.

Passphrases come from `ESTOC_PASSPHRASE` if set, else a no-echo prompt on
a TTY, else one line of stdin per prompt (`printf 'pw\npw\n' | estoc init`).

## Vault layout

```
my-vault/
  your files, untouched…
  .estoc/                # mode 0700
    config.json          # {"format":"estoc","version":2,"identity":{"anchor":{key,did}}}
    keystore.json        # @estoc/keystore v3: sealed seed + a cache of key names, mode 0600
    devices/<dev>/       # each device's event log; init records the label there as identity.label
    local/               # this copy's own state (device id, daemon pid and token, agent options and trace); left out of backups
```

The format is version 2 of `@estoc/vault` (`docs/vault-folder.md`,
`docs/vault-events.md`). The CLI writes the config, the keystore and the
one label event; everything else (mediation, contacts, messages) is the
agent's business, which `estoc serve` runs. Every read starts at
`config.json`: a version 1 vault, an unknown version or a damaged config is
refused before anything else of the folder is read. Keystore writes go
through a same-directory temp file plus rename, so a crash never leaves a
truncated keystore behind.

## Commands

```
estoc init [--label <label>]               create a vault here (refuses if .estoc exists)
estoc status                               show the enclosing vault and its keys
estoc key list                             list keys as JSON (no passphrase needed)
estoc key new <name>                       derive a key by name and record it
estoc object hash   [<dir>]                root CID
estoc object sign   [<dir>] [--key <name>] [--out <signedDir>] [--zip <file>]
estoc object verify [<signedDir | signed.zip | objectDir>] [--card card.jws]
estoc serve [--port <n>] [--bind <addr>] [--app <url>] [--token <t>]
```

`estoc serve` runs the daemon (`@estoc/daemon`) on the enclosing vault —
`estoc init` first if there is none — and serves the app
(`@estoc/app`) for it at `http://127.0.0.1:37862/`: the page talks to this
process, and the vault is the folder's `.estoc`, on disk. The link it prints
carries the token (`.estoc/local/daemon/daemon.token`), the one key to the socket;
open that link, not the bare address. `--app <url>` also prints a `?_daemon=`
link for an app served elsewhere (a dev server, or app.estoc.dev), which
connects here with the same token.

`--vault <dir>` (or `ESTOC_VAULT`) points a command at a specific vault
instead of searching upward.

## License

Apache-2.0
