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
  until a UI types the passphrase), `didcomm-node`, and a WebSocket the app
  connects to. The RPC rides JSON with bytes and Maps tagged (`src/codec.ts`).

```
estoc-daemon ~/my-vault            # prints the link to open the app with
estoc-daemon . --port 0 --app http://localhost:4173
```

Access to the socket is a token (`?token=`, kept in
`.estoc/cache/daemon.token`); it listens on loopback and answers nothing
without it. A second UI connecting calls `boot()` like the first and is
told where things stand.

## Fetching what others name

A browser tab cannot reach a private network; a process can. The URL of a
shared package is the sender's word, so the Node host hands the agent a
`packageFetch` (`src/node/guarded-fetch.ts`) that resolves the name, checks
every address it has — and the literal in the URL — against `ipaddr.js`
ranges, and connects only to public unicast. Redirects are not followed.
The mediator's own endpoints are the user's choice and go through the
ordinary fetch.
