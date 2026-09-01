# Changelog

## 0.2.0 — 2026-09-01

The daemon over the version-2 vault (`@estoc/agent-core` 0.18,
`@estoc/vault` 0.2, `@estoc/event-store` 0.1).

- **Boot**: `inspectVault` holds the locked phase (folder open, keystore
  read, no seed); `NotAVault` — a version-1 folder, or a newer format —
  lands on `unreadable`. No config at all is onboarding.
- **`Snapshot`** is projected from the fold: `label`, `mediatorDid` /
  `did` off this device's mediation, contacts and invitations as v2
  records (retired invitations dropped), `messages` as
  `{ record, contactCid }[]` with the contact attributed by the fold,
  `deliveries` per outbound message, `damaged` = damaged log lines plus
  bodies that would not read back.
- **Backup**: export = `snapshot` + `zipFiles`; merge = `importVault` +
  `holdImported` + `keys.rebuildCache` under a reopen; restore =
  `restoreFolder` + `holdImported` — the restored copy is a fresh device
  and arranges its own mediation afterwards. `filesFromZip` runs before
  anything lands, and every refusal after `restoreFolder` wipes and
  rethrows, so each retry starts from the empty folder.
- **Trace** is served from the vault's `local/agent/` (`AgentTrace`),
  readable the moment the vault is open, locked included; the level lives
  in `local/agent/options.json`, so the host's `traceLevel` /
  `setTraceLevel` hooks are gone and forgetting the identity resets it.
- **Node host**: pid and token live in `.estoc/local/daemon/`; `wipe` is
  `rm .estoc` plus retaking the pid.
- **Events**: `delivery(delivery, record)` carries the fold's word;
  `invitation(record, gone)` uses `retired`.

## 0.1.0 — 2026-08-29

First release: `Daemon` (`src/api.ts`) — an agent and its vault behind
one interface a UI talks to, calls one way and `DaemonEvents` back —
with two hosts, the browser worker (in `@estoc/app`) and the Node host
behind a WebSocket (`estoc-daemon`, token on the socket, serves the app
itself); `traceOf(mid)`, `traceLevel` / `setTraceLevel`.
