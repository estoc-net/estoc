# Estoc

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/estoc-net/estoc)

An offline-first DIDComm v2 messenger you install as a web app. One
identity from one seed, minted in your browser; your contacts and message
history in a vault the browser keeps for you; a zip you can walk away with.
Mail travels through a mediator of your choosing, sealed so the mediator
carries envelopes it cannot open.

Estoc runs on nothing of ours. This app is a static site: deploy it
anywhere (the button above puts a copy on your own Cloudflare account),
point it at any mediator ([didcomm-mediator] is one anyone can run), and
your data never touches the place the app was served from.

## What it does

- **Identity from a seed.** Creating an identity takes a name and a
  passphrase, nothing else: it generates a 32-byte seed and seals it under
  the passphrase ([@estoc/keystore] v3). Every key is derived from that
  seed: an anchor `did:key`, and — once you choose a mediator — the
  `did:peer:4` the mediator knows you by and the public `did:peer:4` you
  hand to contacts. You type the passphrase once; the unlocked seed stays
  in this browser as a non-extractable WebCrypto key. **Lock** forgets it
  and asks again.
- **A mediator, chosen after — and changeable.** An identity exists before
  it can be reached. The rail says *not reachable yet* until you pick a
  mediator there; the choice mints your public DID, whose address is that
  mediator's. *Change mediator* on the rail moves you: every DID of yours
  is minted anew on the new mediator, each contact you have written to is
  told from the new one (a DIDComm `from_prior` on a trust-ping, so they
  follow before you say a word), open invitation links are withdrawn, and
  the old mediator is asked to stop taking mail for you. What cannot
  follow is a business card already handed out: it names the old
  mediator, and a stranger who only has it is bounced there.
- **A DID per conversation.** The public DID on the rail is a business
  card: what strangers write to. The first message you send anyone goes
  out from a `did:peer:4` minted for that person alone (the chat head
  shows it as *you as …*), and someone who first wrote to your public DID
  is moved to a private one on your first reply — announced the DIDComm
  way, with `from_prior`, so their side follows without a word from you.
  Two contacts of yours cannot compare notes and learn they share you; the
  mediator, which queues for every DID under your account, still can.
- **Invitation links.** *New invitation link* on the rail mints a DID for
  one person and puts it in a link (and a QR code) — this deployment's URL
  carrying `?_oob=`, the DIDComm out-of-band invitation, which any Estoc
  opens; whoever opens it is asked to name you and accept, and you see them
  arrive. The first person to write to it takes it; a second is turned
  away. Neither side's public DID is ever involved, so neither has to move
  anywhere afterwards. Open links can be revoked from the rail; a pasted
  link also works in *+ contact*, next to a pasted DID.
- **A vault in the browser.** Contacts and messages live in an `.estoc/`
  directory in this origin's private file system (OPFS) — the same folder
  format every Estoc client reads, written by [@estoc/agent-core]:
  `config.json`, `keystore.json`, `contacts/*.json`, an append-only
  `messages/*.jsonl` log. Nothing about you is stored anywhere else.
- **Backups you own.** **Export backup** zips that directory, unchanged.
  **Restore a backup** on a fresh install makes that browser your
  identity's home. **Import backup** into a live vault *merges*: new
  messages become a new log segment, contacts win by their last change,
  nothing already here is touched — so backups from two devices fold
  together instead of overwriting each other. Either way, a message the
  backup holds unsent is *held*, not sent on its own — a backup is a move,
  not a sync — until you retry it. A backup from a different
  identity is refused.
- **Offline.** Installed, Estoc opens with no network at all: the app
  shell and the didcomm WASM are cached by a service worker, the vault is
  on disk. Reading history needs nothing. Writing needs nothing either: a
  message is appended to the log before any delivery is tried, and what
  could not go waits in the outbox — marked *sending…* or *not sent* under
  the bubble — and goes when the mediator is back (at the next start, when
  the socket reconnects, or ahead of your next message to that contact),
  in order, never twice; *retry* sends one by hand. Receiving resumes when
  the mediator is reachable.
- **One agent per vault.** A second tab of the same browser waits for the
  first (Web Locks) rather than opening a second agent onto the same log.

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

The e2e script (playwright-core, system chromium) mints Alice and Bob in
isolated browser contexts (unreachable first, then each picks the
mediator) and walks the whole surface: live delivery
without a reload, both writing from pairwise DIDs (and a pasted public
DID finding the contact its pairwise DID created), an invitation link Bob
issues and a third identity, Carol, opens before she exists — onboarding,
mediator, then accepting it — after which the two talk over the DIDs it
minted, Bob moving to another mediator (his public DID replaced, an open
invitation link withdrawn, Alice told by `from_prior` and writing to him
there without a word from him — the target is `mediator.estoc.dev`, or
its did:peer:2 name when the run is already there, so a local run needs
the internet for that step; `E2E_OTHER_MEDIATOR=<label>` picks another
entry), history surviving a
reload with no passphrase, a second
tab yielding to the first, lock and unlock (a wrong passphrase refused), a
backup exported and restored in a fresh browser that then receives mail as
Alice, a backup merged into a live vault with nothing new, and — when a
service worker is serving — a message written with the network off (in
the thread at once, marked *not sent*, still there after an offline
reload) that reaches Bob by itself once the network is back, and the app
shell opening offline.

## How it hangs together

- **The agent is [@estoc/agent-core]**: mediation (coordinate-mediation
  3.0), pickup and live delivery (messagepickup 3.0 over HTTP and
  WebSocket), routing 2.0 forwards, user-profile/1.0 introductions, and
  the `.estoc` vault format over an OPFS backend.
- **The daemon is a worker — or a process**: the agent and its vault run
  behind the `Daemon` interface of `@estoc/daemon` (`packages/daemon`), and
  the UI reaches it only through that interface over an RPC: records and
  bytes cross, no vault, key or agent does. By default `src/daemon/worker.ts`
  hosts it in a dedicated worker of the page — OPFS for the bytes, the vault
  lock (`lock.ts`), the unlocked seed in IndexedDB (`keycache.ts`). Opened
  with the link `estoc-daemon` prints (`?_daemon=ws://…`), the page instead
  talks to that process over a WebSocket (`src/daemon/client.ts`), its
  vault a folder on disk, and remembers the choice until `?_daemon=off`.
  `src/core/store.ts` is the UI side — Vue views projected from the
  daemon's snapshot and kept current by its events.
- **Screens follow the disk**: nothing there → onboarding (create or
  restore); a vault without its cached seed → unlock; otherwise straight
  in — the daemon says which, by a `phase` event.
- **PWA**: [vite-plugin-pwa] generates the manifest and a Workbox service
  worker precaching the shell (scripts, styles, WASM). Updates wait for a
  nod (a chip offers to reload); `navigator.storage.persist()` is asked
  for when the vault is created, and the rail says whether the browser
  granted it. Icons render from `public/icon.svg` via `pnpm icons`.
- **Every record, homed; renderers by type**: the store keeps each log
  record as an `Entry` (`src/core/entries.ts`: the record plus the contact
  it belongs to and its time), whatever its type. `src/renderers/` maps
  message types to Vue components — basicmessage bubbles, profile
  introductions, a generic one for anything nobody registered (it names
  the protocol and shows the body), and a silent one for heartbeats and
  profile requests. A renderer takes its entry through props and never
  imports the store: that seam is where third-party renderers (in a
  sandboxed frame, or arriving in the vault) would slot in. Sending is
  the same shape: `send(contactDid, type, body)` in the store; the
  composer is just the basicmessage caller of it.
- **The didcomm WASM** is instantiated by `src/didcomm/wasm.ts` (the npm
  package's entry is webpack-shaped) and handed to the agent.

## Status

Early. Pairwise DIDs per contact, single-use invitation links, an
outbox for what is written offline, and a change of mediator that rotates
every DID; no push notifications (a mediator extension); keys in the
browser under your
passphrase. Storage is only
guaranteed once the browser grants persistence — install the app, and keep
a backup either way. Browsers: Chromium and Firefox, and Safari 26 or later
(the vault is written through OPFS `createWritable()`, which WebKit shipped
in Safari 26; older Safari gets a plain error at onboarding). Nothing here
has had an independent security audit.

## License

Apache-2.0

[@estoc/agent-core]: https://github.com/estoc-net/estoc/tree/main/packages/agent-core
[@estoc/keystore]: https://github.com/estoc-net/estoc/tree/main/packages/keystore
[didcomm-mediator]: https://github.com/estoc-net/didcomm-mediator
[vite-plugin-pwa]: https://vite-pwa-org.netlify.app/
[estoc-net/estoc]: https://github.com/estoc-net/estoc
