# @estoc/daemon

The Estoc daemon: an agent and its vault behind one interface, `Daemon`
(`src/api.ts`), that a UI talks to and never reaches around. Calls go one
way, events (`DaemonEvents`) come back; everything that crosses is a plain
record or bytes — no vault, no key, no agent. `createDaemon(host, emit)`
is the daemon itself; a `DaemonHost` says where it runs.

Two hosts ship:

- **A browser worker** (the app's `src/daemon/worker.ts`): OPFS, Web Locks,
  the seed in IndexedDB, the DIDComm WASM as Vite loads it. The RPC rides a
  message port (`serve` / `connect` in `src/rpc.ts`; structured clone).
- **A Node process** (`@estoc/daemon/node`, the `estoc-daemon` command): a
  folder on disk (`FsBackend` from `@estoc/event-store/node`, `<folder>/.estoc` the vault), a pid file for
  one daemon per folder, the seed in memory only (every start is locked
  until a UI types the passphrase), `didcomm-node`, and one HTTP server
  that serves the app and takes the app's WebSocket on the same origin. The
  app is `@estoc/app` (the built files), an optional peer: `estoc serve`
  from `@estoc/cli` brings both together; `estoc-daemon` alone serves the
  app if `@estoc/app` is installed beside it (or `--app-dir`), else prints
  a link to app.estoc.dev. The RPC rides JSON with bytes and Maps tagged
  (`src/codec.ts`).

```
cd ~/my-vault && estoc init && estoc serve   # open the link it prints: http://127.0.0.1:37862/?token=…
estoc-daemon . --port 0 --app http://localhost:5173   # also a ?_daemon= link for a dev server
```

The token (kept in `.estoc/local/daemon/daemon.token`) is the one key to the
socket, whoever asks: the page the daemon serves finds the socket at its
own origin (index.html is sent with a `<meta name="estoc-daemon">`) and
takes the token from the `?token=` in the link, remembering it for reloads
and other tabs; any other origin — a dev server, app.estoc.dev — connects
with the `?_daemon=` link, which carries the socket URL with the token,
and remembers it until `?_daemon=off`. Being a page of the daemon's own
buys nothing: a browser on the machine (or on the network, when bound
wider) that has no link has no socket. On top of that `Host` must be a
name of this server's (a loopback name, the bound address, or an address
of this machine when bound to all); anything else, such as an attacker's
name pointed at 127.0.0.1 (DNS rebinding), gets 421 and no socket. A
second UI connecting calls `boot()` like the first and is told where
things stand.

## The trace

The vault keeps what its agent observes on the way in and out — frames,
envelopes, the rituals with mediators — in `.estoc/local/agent/trace/`,
one stream per kind, under a retention (`docs/vault-folder.md` §7, local
state: this device's own, left out of backups). The daemon reads it for
the UI straight from the folder, so it answers the moment the vault is
open — locked included: `traceOf(mid)` is one message's onion, outermost
frame to innermost envelope, empty when the trace is off or that part is
pruned. How much is kept is a device preference, `off` / `normal` /
`verbose`: `traceLevel()` and `setTraceLevel(level)`, kept in
`.estoc/local/agent/options.json` — with the vault, so forgetting the
identity resets it — and a stricter level prunes at once.

## Fetching what others name

A browser tab cannot reach a private network; a process can. The URL of a
shared package is the sender's word, so the Node host hands the agent a
`packageFetch` (`src/node/guarded-fetch.ts`) that resolves the name, checks
every address it has — and the literal in the URL — against `ipaddr.js`
ranges, and connects only to public unicast. Redirects are not followed.
The mediator's own endpoints are the user's choice and go through the
ordinary fetch.

## Version 3

`@estoc/daemon/v3` is the daemon over the version-3 vault — one SQLite
file, the agent of `@estoc/agent-core/v3` over it — built beside the
entries above until the app and the CLI move to it. `createDaemon(host,
emit)` takes a `DaemonHost` whose storage is SQLite files by name; the
RPC (`serve`, `connect`) and the text encoding are the same.
`@estoc/daemon/v3/node` has `nodeHost(root)`, whose vault is
`<root>/.estoc/vault.sqlite`, and `serveDaemon`.

A host hands its files to one daemon at a time, from `storage()` to the
storage's `close()`; the Node host keeps an empty `owner.sqlite` open
beside the vault for that, under SQLite's own lock, so a second daemon
on the folder says `elsewhere`, refuses what would make, open or remove
a file, and waits. Within a daemon those calls — `createIdentity`,
`restoreIdentity`, `unlock`, `lock`, `forgetIdentity`, `exportBackup`,
`mergeBackup` — run one at a time in the order asked, and `close()`
ends a wait for files held elsewhere.

The UI is told the vault whole: `opened(snapshot)` once, then
`changed(snapshot)` after every call it makes and every delivery; what
changed with neither — a retry the dispatcher made on its own — is read
with `refresh()`. Nothing is sent on open: what an earlier run left
unfinished is in `snapshot.pending`, each entry naming the call that
takes it up.

A vault restored from a snapshot opens with `restoreUnexplained`. It
receives, reconciles and answers from the first moment, and refuses the
user's sends and every manual dispatch until the UI has shown what a
restore cannot bring back — local DIDs made after the snapshot, peers
known only by a short form, continuity the snapshot predates, forks a
competing rotation leaves — and called `explainedRestore()`.
