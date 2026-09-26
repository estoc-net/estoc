# Changelog

## Unreleased

- `send` takes no `preRotation`: a channel a replacement of either end
  has moved on from takes no send, whoever asks.
- `Merged` has no `conflicts`: the version-4 vault has no same-ID
  conflicts to count. Records name events by `cid`.

- **Phase `damaged`**: a vault whose history no longer reads whole is
  not run. The daemon says so with the damage as the detail, whether it
  finds it locked, with its seed at hand, or while the vault runs,
  whichever read meets it first — the one a vault opens with, the one
  after a change, the one replayed to a listener that joins (the
  records short of the damaged event are not shown, the agent is
  stopped and the file let go of). `forgetIdentity` makes room for a
  restore. `DAMAGE_RECOURSE` is the explanation for a host with no
  words of its own.
- `mergeBackup` recovers from a forked author: when the backup and the
  vault both wrote under one replica ID, the vault is reopened under a
  fresh one and the merge made again, with no agent over it until the
  merge is over; `Merged.renewed` says so.
- `Lines.connections[].unknownRegistrations`, from the agent.
- `createContact` refuses an empty channel list: a contact is created
  with at least one channel.

## 0.3.0 — 2026-09-20

The daemon over the version-3 vault, in place of the version-2 one.

- **Version 3 is the package.** What was `@estoc/daemon/v3` and
  `@estoc/daemon/v3/node` are now `@estoc/daemon` and
  `@estoc/daemon/node`, and the `./v3` entries are gone; every entry
  below that names them describes what these export now.
- **The version-2 daemon is removed**: its `createDaemon`, `Daemon`
  and `Snapshot`, the folder backup, and the Node host over `FsBackend`
  with its pid file, with the upstream `didcomm-node` and
  `@estoc/folder-object` dependencies. `guardedFetch` is the Node
  host's default fetch and is no longer exported.

- **`estoc-daemon` runs the version-3 daemon.** `runDaemon`,
  `installedApp` and `exitOnSignal` moved from `@estoc/daemon/node` to
  `@estoc/daemon/v3/node`, and the bin with them. A folder that holds a
  folder-format vault is refused at the start with nothing written to
  it. The token is `.estoc/daemon.token`; once the folder is the
  daemon's own, the socket's URL is left in `.estoc/daemon.url` until it
  closes, for a process on this machine the folder is refused to. The
  record is removed before the folder is let go, so a daemon that takes
  over keeps its own; a `runDaemon` that fails past listening closes
  what it opened before it rejects. `vaultDir` makes `.estoc` and closes
  one that stood open to others to 0700.
- **`Snapshot.anchor`**: the did:key the vault's seed derives.
- Node 22.13 is the oldest that runs it, which is what `node:sqlite`
  needs.

- **`@estoc/daemon/v3`** and **`@estoc/daemon/v3/node`**: the daemon
  over the version-3 vault, built beside the entries above, which stay
  as they are. The host provides SQLite files by name
  (`DaemonStorage`), to one daemon at a time from `storage()` to the
  storage's `close()`: the vault is `vault.sqlite`, a snapshot crosses
  as the bytes of its file, and a second daemon lands on `elsewhere`,
  refuses whatever would make, open or remove a file, and waits. The
  Node host keeps them in `<root>/.estoc/`, holds an empty
  `owner.sqlite` open there under SQLite's own lock for as long as the
  folder is its daemon's, says `unreadable` over a folder-format vault
  and writes nothing beside it, loads `@estoc/didcomm-node`, and gives
  the agent a fetch that refuses addresses that are not public.
- **One operation on the files at a time.** `createIdentity`,
  `restoreIdentity`, `unlock`, `lock`, `forgetIdentity`, `exportBackup`
  and `mergeBackup` run in the order asked, so of two vaults asked for
  at once one is made and the other refused with nothing removed, a
  lock of a locked vault changes nothing, and exports and merges asked
  for together each finish on a snapshot file of their own turn. A
  vault file is removed only by the call that made it or by
  `forgetIdentity` of the daemon that holds it. `close()` ends a wait
  for files held elsewhere, waits for the operation under way, lets go
  of everything, and answers the same to every caller; nothing is
  opened or said after it.
- **An agent let go of starts no request, and the ones it has are
  waited for.** When the daemon closes, locks, forgets the vault or
  replaces the agent after a merge, the agent's fetch refuses whatever
  it is asked next, new calls over the agent are refused, and what is
  under way is waited for before the vault closes or the next agent
  connects: every call over the agent, and every request it has out
  until its response is over, whether a call began it, a retry on its
  timer or a delivery down its socket. A removal on its way so lands
  before anything is registered next. A request is waited for as long
  as the deadline its caller set, which is how long `close()` can take;
  one that outlasts it may still take effect at the other end later,
  and a reconciliation after it sees and mends only what stands there
  at the time. A host may set the agent's retry policy
  (`agentOptions.retry`).
- **The text encoding carries any record as it was.** A record whose
  one key starts with `$` — `{"$bytes": "…"}` in a message body — came
  back as bytes or a Map, or failed to decode. Such a record now goes
  out with one more `$` on its key and comes back with one fewer;
  `decode` throws on a tag that is none of its own. Both ends of a
  socket need this version. A frame that does not decode closes the
  socket it came on (1007) rather than the process, and `serve` leaves
  unanswered whatever is no call — a record with a numeric `id`, a
  string `method` and an array of `args` — and answers a call only from
  its target's own methods.
- **`Snapshot`** is the vault as `@estoc/agent-core/v3` records off one
  fold — arrangements, local DIDs, contacts, each channel record once,
  unplaced observations, invitations, pending work — told whole as
  `opened` and again as `changed` after every call and every delivery;
  `lines` carries what only the running agent knows (connections,
  waiting and discarded deliveries).
- **Calls**: `setMediator`, `createInvitation`, `acceptInvitation`,
  contacts (`createContact`, `renameContact`, `setContactChannels`,
  `deleteContact`), `blockChannels`, `eraseMessage`, `send`, and the
  manual steps the records name: `retry`, `cancel`, `completeResponse`,
  `completeNotification`, `rotate`; `pending`, `refresh`, `reconnect`.
- **Restore**: `restoreIdentity` takes a portable snapshot's bytes and
  the passphrase of its own wrapped seed. Until `explainedRestore`, the
  snapshot says `restoreUnexplained` and `send`, `acceptInvitation`,
  `retry`, `completeResponse`, `completeNotification` and `rotate` are
  refused; pickup, reconciliation, receipts and their automatic effects
  go on. The mark is this runtime's own local option, so another
  process over the same file owes the explanation still.
- `serveDaemon`'s socket server moved to `node/socket.ts` (`serveOver`),
  shared by both versions; a served daemon that has `close()` is closed
  with its server.

- **`block(cid)`** reads a block of the vault's `blobs/` by CID — what
  the app's object-share renderer hands `verifyShare` as `held`. It read
  `blob(cid)` before, which is a *file* read: since a recorded share's
  blocks are in `blobs/` and its body names them by id (agent-core
  0.18 unreleased), the renderer read the share's directory nodes that
  way and every stored share failed to show, "not a file". `blob(root)`
  stays a file read, chunks rejoined, and is documented as one.

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
