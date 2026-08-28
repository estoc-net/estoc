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
  folder on disk (`FsBackend`, `<folder>/.estoc` the vault), a pid file for
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

The token (kept in `.estoc/cache/daemon.token`) is the one key to the
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

## Fetching what others name

A browser tab cannot reach a private network; a process can. The URL of a
shared package is the sender's word, so the Node host hands the agent a
`packageFetch` (`src/node/guarded-fetch.ts`) that resolves the name, checks
every address it has — and the literal in the URL — against `ipaddr.js`
ranges, and connects only to public unicast. Redirects are not followed.
The mediator's own endpoints are the user's choice and go through the
ordinary fetch.
