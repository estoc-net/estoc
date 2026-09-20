# @estoc/cli

`estoc` — the command-line client for Estoc vaults.

A vault is any folder you own with a `.estoc` directory inside. The model
is git's: **the folder holds your content, `.estoc` holds the machinery** —
one SQLite vault, and in it one seed sealed under a passphrase
([`@estoc/keystore`](../keystore) v3), from which every key is derived by
name. `estoc init` never touches your files; it only adds `.estoc`.
Commands discover the enclosing vault by walking upward from the working
directory, exactly like git finds its repository. The vault is the one
[`@estoc/daemon`](../daemon) runs, and a backup the app exports is a
snapshot of the same format.

```sh
cd ~/my-vault
estoc init                   # prompts for a passphrase; seals a seed, mints the anchor key
estoc status                 # vault path, label, anchor — no passphrase needed
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

`sign` defaults to the vault's `anchor` key; `--key <name>` takes the key
that name derives under the same seed, always the same one, recorded
nowhere. A command that unlocks the seed first derives the anchor from it
and compares it with the vault's own: a seed that derives another anchor
is the wrong seed for this vault.

Passphrases come from `ESTOC_PASSPHRASE` if set, else a no-echo prompt on
a TTY, else one line of stdin per prompt (`printf 'pw\npw\n' | estoc init`).

## Vault layout

```
my-vault/
  your files, untouched…
  .estoc/                # mode 0700
    vault.sqlite         # the vault: events, objects, the sealed seed, this copy's own state
    owner.sqlite         # empty; whoever holds its lock holds the folder
    daemon.token         # the daemon's access token, once one has run here
    daemon.url           # where the daemon listens, while one runs
```

The CLI makes the vault and its one label event; everything else
(mediation, contacts, messages) is the agent's business, which
`estoc serve` runs. A `.estoc` of the earlier folder format (it has a
`config.json`) is refused by every command and left as it is.

The folder is one process's at a time. A command takes it for as long as
it runs. While a daemon runs on the vault the folder is the daemon's:
`init` and `status` find it taken and ask the daemon at its socket
instead — a vault the daemon holds locked shows its phase and no more —
and `object sign` is refused, because the seed the daemon unlocked stays
in the daemon.

## Commands

```
estoc init [--label <label>]               create a vault here (refuses where one stands)
estoc status                               show the enclosing vault, and the daemon that holds it
estoc object hash   [<dir>]                root CID
estoc object sign   [<dir>] [--key <name>] [--out <signedDir>] [--zip <file>]
estoc object verify [<signedDir | signed.zip | objectDir>] [--card card.jws]
estoc object render [<signedDir | signed.zip | objectDir>] [--template <html>] [--out <file>] [--asset-base <prefix>]
estoc serve [--port <n>] [--bind <addr>] [--app <url>] [--token <t>]
```

`estoc serve` runs the daemon (`@estoc/daemon`) on the enclosing vault —
`estoc init` first if there is none — and serves the app
(`@estoc/app`) for it at `http://127.0.0.1:37862/`: the page talks to this
process, and the vault is in the folder's `.estoc`, on disk. The link it prints
carries the token (`.estoc/daemon.token`), the one key to the socket;
open that link, not the bare address. `--app <url>` also prints a `?_daemon=`
link for an app served elsewhere (a dev server, or app.estoc.dev), which
connects here with the same token.

`--vault <dir>` (or `ESTOC_VAULT`) points a command at a specific vault
instead of searching upward.

## License

Apache-2.0
