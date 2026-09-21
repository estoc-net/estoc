# Estoc

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/estoc-net/estoc)

An offline-first DIDComm v2 messenger you install as a web app. One
identity from one seed, minted in your browser; your contacts and message
history in a vault the browser keeps for you; a file you can walk away with.
Mail travels through a mediator of your choosing, sealed so the mediator
carries envelopes it cannot open.

Estoc runs on nothing of ours. This app is a static site: deploy it
anywhere (the button above puts a copy on your own Cloudflare account),
point it at any mediator ([didcomm-mediator] is one anyone can run), and
your data never touches the place the app was served from.

## What it does

- **Identity from a seed.** Creating an identity takes a name and a
  passphrase, nothing else: it generates a 32-byte seed and seals it under
  the passphrase ([@estoc/keystore]). Every key is derived from that seed.
  You type the passphrase once; the unlocked seed stays in this browser as
  a non-extractable WebCrypto key. **Lock** forgets it and asks again.
- **A mediator, chosen after.** An identity exists before it can be
  reached. The rail says *not reachable yet* until you pick a mediator
  there. Choosing another later changes where the DIDs you mint from then
  on are reached; the ones you have stay where they are until you rotate
  them, a conversation at a time.
- **Invitation links, and no public DID.** There is no address of yours
  for strangers to write to. *New invitation link* on the rail mints a DID
  for one person and puts it in a link (and a QR code): this deployment's
  URL carrying `?_oob=`, the DIDComm out-of-band invitation, which any
  Estoc opens. Whoever opens it names you and accepts, from a DID minted
  for you alone; the first to write takes the link and a second is turned
  away. A pasted link works in *+ contact*.
- **Channels, and a DID per conversation.** A conversation is one or more
  channels, each a pair of one DID of yours and one of theirs. The DID in a
  link was disclosed, so the first message written to it moves you to a
  private one for that person, announced the DIDComm way with `from_prior`
  so their side follows. *Rotate my DID* under a conversation's channels
  does the same by hand. The chat head lists the channels: which one is
  current, which are history, and what stands in the way of writing in
  one (blocked, in conflict, the peer moved on).
- **Names are yours.** Someone who arrives over a link of yours shows up
  under what they call themself, quoted as the claim it is, until you name
  the conversation; that makes them a contact. Contacts can be renamed,
  deleted (optionally blocking their channels and erasing their messages),
  and any message's content can be erased.
- **The vault's own account of every message.** Under a bubble: where a
  delivery stands (queued, sealed, handed over, received, expired,
  cancelled, conflict), whether an input has been taken in, and what
  became of a continuity proof it brought. Opening a vault sends nothing:
  a message a transport was never called for, a reply still owed, a
  rotation the peer was never told of, each waits under *Left to do by
  hand* on the rail for the step named beside it.
- **A vault in the browser.** Everything lives in one SQLite database in
  this origin's private file system, through SQLite's access-handle pool
  in the daemon's worker ([@estoc/event-store]). Nothing about you is
  stored anywhere else.
- **Backups you own.** **Export backup** writes the vault as one portable
  `.sqlite` file. The passphrase seals the seed in it and nothing else:
  whoever has the file reads the messages. **Restore a backup** on a fresh
  install brings back that moment and nothing after it, and says so before
  anything can be sent: DIDs minted since, addresses contacts moved to
  since, and what tied old to new are not in it, and mail for or from
  those is discarded on arrival (the rail lists what was turned away).
  **Import backup** into a live vault *merges*: events the vault lacks are
  added, nothing already here is touched, so backups from two devices fold
  together. A message a backup holds unsent is not sent on its own.
- **Offline.** Installed, Estoc opens with no network at all: the app
  shell and the WASM are cached by a service worker, the vault is on disk.
  Reading history needs nothing. Writing needs nothing either: a message
  is in the vault before any delivery is tried. One the mediator could not
  be reached for is tried again on a timer while the app stays open; after
  a restart it waits for *send again*.
- **One agent per vault.** A second tab of the same browser waits for the
  first (the pool's Web Lock) rather than opening a second agent.
- **An older vault is left alone.** A vault of the earlier folder format
  is not read or converted. The app says so and changes nothing; *start
  over* deletes it.

## Run it

This directory is one package of the [estoc-net/estoc] workspace, alongside
the libraries it is built from (`packages/{did-peer,keystore,agent-core}`),
which it takes straight from the tree — no publish step between a library
change and the app seeing it. From the workspace root:

```sh
pnpm install
pnpm dev             # tsc --watch on every library + vite here
```

or `pnpm dev` in this directory once the libraries have been built.

The rail's mediator dropdown defaults to `mediator.estoc.dev`
([didcomm-mediator] on Cloudflare Workers) and also offers a local one
(`npm run dev` in the [didcomm-mediator] repo, minted with
`MEDIATOR_PUBLIC_URL=http://localhost:8080`), or paste any mediator's
out-of-band invitation URL, its URL, or its DID. Opening the app through a
mediator's invitation link (`?_oob=` with `goal_code: request-mediate`)
pre-fills that field.

## Deploy your own

The button seeds a copy of the whole workspace into your GitHub account and
deploys it to workers.dev; `pnpm run deploy` from a checkout (here or at
the workspace root) does the same. Both run the build first, via
`build.command` in the root `wrangler.jsonc`, which builds the workspace
libraries and then this app — so what you deploy is built from the
libraries in your copy, not from npm. Custom domains
attach in the Cloudflare dashboard, not in `wrangler.jsonc`, so the config
deploys on any account unchanged.

To make your own mediator the default, set `VITE_MEDIATOR_DID=<its DID>`
at build time — in `.env.production` before `pnpm run deploy`, or, on a
button deploy, prefixed to the **deploy command** on the setup page
(`VITE_MEDIATOR_DID=… pnpm run deploy`; it has to ride the deploy command,
whose build is the one that ships). Change it later under the Worker's
**Settings → Build → Build variables** and push any commit.

## Verify

```sh
pnpm typecheck
pnpm build && pnpm preview           # serves dist/ on :4173 with the service worker
pnpm e2e                             # against localhost:8080 (a local mediator)
E2E_MEDIATOR=estoc pnpm e2e          # against mediator.estoc.dev
node scripts/e2e.mjs https://<your deployment>
```

The e2e script (playwright-core, system chromium) mints Alice, Bob and
Carol in isolated browser contexts (unreachable first, then each picks
the mediator) and walks the whole surface: an invitation link pasted into
*+ contact*, the inviter seeing the arrival under a claimed name and
naming it, live delivery without a reload, the disclosed DID giving way
to a private one, a rotation by hand with the thread going on over it, a
link opened before its reader has an identity, history surviving a reload
with no passphrase, a second tab yielding to the first, lock and unlock
(a wrong passphrase refused), a backup merged into the live vault with
nothing new, the same backup restored in a fresh browser where sending
waits for the restore to be explained, and, when a service worker is
serving, a message written with the network off that is still there after
an offline reload and goes out by hand once the network is back.

`scripts/e2e-daemon.mjs` drives the app against `estoc serve`, using
`@estoc/daemon/v3` and the public mediator at `mediator.estoc.dev`.
Run `node scripts/e2e-daemon.mjs` with the built app available as described
at the top of the script; an optional first argument sets the app URL.

## How it hangs together

- **The agent is [@estoc/agent-core]** (`/v3`): mediation
  (coordinate-mediation 3.0), pickup and live delivery (messagepickup 3.0
  over HTTP and WebSocket), routing 2.0 forwards, trust-ping, receipts,
  rotation by `from_prior`, user-profile/1.0 introductions, over the
  SQLite vault (`@estoc/event-store`, `@estoc/vault`).
- **The daemon is a worker, or a process**: the agent and its vault run
  behind the `Daemon` interface of `@estoc/daemon/v3` (`packages/daemon`),
  and the UI reaches it only through that interface over an RPC: records
  and bytes cross, no vault, key or agent does. By default
  `src/daemon/worker.ts` hosts it in a dedicated worker of the page: the
  SQLite pool over an OPFS directory for the files, the unlocked seed in
  IndexedDB (`keycache.ts`). Served by a daemon itself (its index.html
  marked, its link carrying the token as `?token=`, remembered here), or
  opened with the `?_daemon=ws://…` link a daemon prints, the page instead
  talks to that process over a WebSocket (`src/daemon/client.ts`); the
  link is remembered until `?_daemon=off`. `src/core/store.ts` is the UI
  side: every snapshot the daemon sends replaces the one before, whole,
  and `src/core/conversations.ts` reads it as conversations.
- **Screens follow the disk**: nothing there → onboarding (create or
  restore); a vault without its cached seed → unlock; otherwise straight
  in — the daemon says which, by a `phase` event.
- **PWA**: [vite-plugin-pwa] generates the manifest and a Workbox service
  worker precaching the shell (scripts, styles, WASM). Updates wait for a
  nod (a chip offers to reload); `navigator.storage.persist()` is asked
  for when the vault is created, and the rail says whether the browser
  granted it. Icons render from `public/icon.svg` via `pnpm icons`.
- **Renderers by type**: a thread is the message records of every channel
  a conversation shows. `src/renderers/` maps message types to Vue
  components: basicmessage bubbles, profile introductions, a generic one
  for anything nobody registered (it names the protocol and shows the
  body). What the vault sends and receives on its own account (receipts,
  heartbeats, rotation notices) takes no line unless something about it
  needs the person. A renderer takes its record through props and does not
  import the store: that seam is where third-party renderers would slot
  in. The frame around it (`Bubble.vue`) is the vault's account of the
  message and the manual steps it leaves open.
- **Trace**: how much the device keeps of what its agent observes is the
  rail's level (off / normal / verbose), local state of this copy and in
  no backup. Nothing in this build reads the trace back yet.
- **The didcomm WASM** is instantiated by `src/didcomm/wasm.ts` (the npm
  package's entry is webpack-shaped) and handed to the agent.

## Status

Early. A DID per conversation, single-use invitation links, rotation,
manual completion of whatever a crash or a restore left undone; no push
notifications (a mediator extension); keys in the browser under your
passphrase. Storage is only guaranteed once the browser grants
persistence: install the app, and keep a backup either way. The vault
needs OPFS synchronous access handles in a worker, which current
Chromium, Firefox and Safari have; only Chromium is exercised by the e2e.
Nothing here has had an independent security audit.

## License

Apache-2.0

[@estoc/agent-core]: https://github.com/estoc-net/estoc/tree/main/packages/agent-core
[@estoc/keystore]: https://github.com/estoc-net/estoc/tree/main/packages/keystore
[@estoc/event-store]: https://github.com/estoc-net/estoc/tree/main/packages/event-store
[didcomm-mediator]: https://github.com/estoc-net/didcomm-mediator
[vite-plugin-pwa]: https://vite-pwa-org.netlify.app/
[estoc-net/estoc]: https://github.com/estoc-net/estoc
