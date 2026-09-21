# @estoc/daemon

The Estoc daemon: an agent and its vault behind one interface, `Daemon`
(`src/api.ts`), that a UI talks to and never reaches around. Calls go one
way, events (`DaemonEvents`) come back; everything that crosses is a plain
record or bytes — no vault, no key, no agent. `createDaemon(host, emit)`
is the daemon itself; a `DaemonHost` says where it runs.

Two hosts ship:

- **A browser worker** (the app's `src/daemon/worker.ts`): the vault is one
  SQLite database in a pool of access handles over OPFS
  (`openSqlitePool` from `@estoc/event-store/browser`), the seed in
  IndexedDB, the DIDComm WASM as Vite loads it. The RPC rides a message
  port (`serve` / `connect` in `src/rpc.ts`; structured clone).
- **A Node process** (`@estoc/daemon/node`; the `estoc-daemon` command):
  `nodeHost(root)`, whose vault is `<root>/.estoc/vault.sqlite`
  (`openNodeSqlite` from `@estoc/event-store/node`), the seed in memory
  only (every start is locked until a UI types the passphrase),
  `@estoc/didcomm-node`, and one HTTP server that serves the app and takes
  the app's WebSocket on the same origin. The app is `@estoc/app` (the
  built files), an optional peer: `estoc serve` from `@estoc/cli` brings
  both together; `estoc-daemon` alone serves the app if `@estoc/app` is
  installed beside it (or `--app-dir`), else prints a link to
  app.estoc.dev. The RPC rides JSON with bytes and Maps tagged
  (`src/codec.ts`).

```
cd ~/my-vault && estoc init && estoc serve   # open the link it prints: http://127.0.0.1:37862/?token=…
estoc-daemon . --port 0 --app http://localhost:5173   # also a ?_daemon= link for a dev server
```

The token (kept in `.estoc/daemon.token`) is the one key to the
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

## The folder

`runDaemon`, the command itself, refuses a folder-format `.estoc` before
writing anything, and once the folder is its own it leaves the socket's
URL, token included, in `.estoc/daemon.url` (mode 0600, removed when it
closes) for a process on this machine that finds the folder taken,
which is how `estoc status` and `estoc init` reach it.

A host hands its files to one daemon at a time, from `storage()` to the
storage's `close()`; the Node host keeps an empty `owner.sqlite` open
beside the vault for that, under SQLite's own lock, so a second daemon
on the folder says `elsewhere`, refuses what would make, open or remove
a file, and waits. Within a daemon those calls — `createIdentity`,
`restoreIdentity`, `unlock`, `lock`, `forgetIdentity`, `exportBackup`,
`mergeBackup` — run one at a time in the order asked, and `close()`
ends a wait for files held elsewhere.

## What the UI is told

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

## The trace

The agent keeps what it observes on the way in and out — frames,
envelopes, the rituals with mediators — in the runtime's local state,
which no snapshot carries. How much is kept is a preference of this
runtime, `off` / `normal` / `verbose`: `traceLevel()` and
`setTraceLevel(level)`.

## Fetching what others name

A browser tab cannot reach a private network; a process can. Every
address the agent is given — a mediator's, a peer's endpoint, a
`did:web` document's — is somebody else's word, so the Node host's
default `fetch` (`src/node/guarded-fetch.ts`) resolves the name, checks
every address it has — and the literal in the URL — against `ipaddr.js`
ranges, and connects only to public unicast. Redirects are not
followed. A mediator on this machine needs `nodeHost(root, { fetch })`
with a fetch that reaches it.
