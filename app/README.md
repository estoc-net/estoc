# Estoc

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/estoc-net/app)

An offline-first DIDComm v2 messenger you install as a web app. One
identity from one seed, minted in your browser; your contacts and message
history in a vault the browser keeps for you; a zip you can walk away with.
Mail travels through a mediator of your choosing, sealed so the mediator
carries envelopes it cannot open — and every message keeps its envelopes,
so you can peel them and see exactly that.

Estoc runs on nothing of ours. This repository is a static site: deploy it
anywhere (the button above puts a copy on your own Cloudflare account),
point it at any mediator ([didcomm-mediator] is one anyone can run), and
your data never touches the place the app was served from.

## What it does

- **Identity from a seed.** Creating an identity generates a 32-byte seed
  and seals it under your passphrase ([@estoc/keystore] v2). Every key is
  derived from that seed: an anchor `did:key`, the `did:peer:4` your
  mediator knows you by, the public `did:peer:4` you hand to contacts.
  You type the passphrase once; the unlocked seed stays in this browser as
  a non-extractable WebCrypto key. **Lock** forgets it and asks again.
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
  together instead of overwriting each other. A backup from a different
  identity is refused.
- **Offline.** Installed, Estoc opens with no network at all: the app
  shell and the didcomm WASM are cached by a service worker, the vault is
  on disk. Reading history needs nothing; sending and receiving resume
  when the mediator is reachable. (An outbox for messages written offline
  is next; today a send with no network fails and stays in the composer.)
- **One agent per vault.** A second tab of the same browser waits for the
  first (Web Locks) rather than opening a second agent onto the same log.
- **See-through.** Select any message and the inspector peels its
  envelopes — plaintext, authcrypt to the recipient, the routing forward,
  anoncrypt to the mediator — naming at each layer who could read it.

## Run it

```sh
npm install
npm run dev
```

The onboarding dropdown defaults to `mediator.estoc.dev` ([didcomm-mediator]
on Cloudflare Workers) and also offers a local one (`npm run dev` in the
mediator repo, minted with `MEDIATOR_PUBLIC_URL=http://localhost:8080`),
or paste any mediator's out-of-band invitation URL, its URL, or its DID.

## Deploy your own

The button clones this repository into your GitHub account and deploys it
to workers.dev; `npm run deploy` from a checkout does the same (both run
the build first, via `build.command` in `wrangler.jsonc`). Custom domains
attach in the Cloudflare dashboard, not in `wrangler.jsonc`, so the config
deploys on any account unchanged.

To make your own mediator the default, set `VITE_MEDIATOR_DID=<its DID>`
at build time — in `.env.production` before `npm run deploy`, or, on a
button deploy, prefixed to the **deploy command** on the setup page
(`VITE_MEDIATOR_DID=… npm run deploy`; it has to ride the deploy command,
whose build is the one that ships). Change it later under the Worker's
**Settings → Build → Build variables** and push any commit.

## Verify

```sh
npm run typecheck
npm run build && npm run preview     # serves dist/ on :4173 with the service worker
npm run e2e                          # against localhost:8080 (a local mediator)
E2E_MEDIATOR=estoc npm run e2e       # against mediator.estoc.dev
node scripts/e2e.mjs https://<your deployment>
```

The e2e script (playwright-core, system chromium) mints Alice and Bob in
isolated browser contexts and walks the whole surface: live delivery
without a reload, four envelope layers on both sides, history surviving a
reload with no passphrase, a second tab yielding to the first, lock and
unlock (a wrong passphrase refused), a backup exported and restored in a
fresh browser that then receives mail as Alice, a backup merged into a live
vault with nothing new, and — when a service worker is serving — the app
opening with the network off.

## How it hangs together

- **The agent is [@estoc/agent-core]**: mediation (coordinate-mediation
  3.0), pickup and live delivery (messagepickup 3.0 over HTTP and
  WebSocket), routing 2.0 forwards packed by hand layer by layer,
  user-profile/1.0 introductions, and the `.estoc` vault format over an
  OPFS backend. `src/core/store.ts` mirrors the vault into Vue views and
  forwards agent events; `src/core/backup.ts` is the zip on either side of
  agent-core's `snapshotVault` / `importVault`.
- **Screens follow the disk**: nothing there → onboarding (create or
  restore); a vault without its cached seed → unlock; otherwise straight
  in. `src/core/lock.ts` takes the vault lock first; `src/core/keycache.ts`
  is the IndexedDB slot for the unlocked seed.
- **PWA**: [vite-plugin-pwa] generates the manifest and a Workbox service
  worker precaching the shell (scripts, styles, WASM). Updates wait for a
  nod (a chip offers to reload); `navigator.storage.persist()` is asked
  for when the vault is created, and the rail says whether the browser
  granted it. Icons render from `public/icon.svg` via `npm run icons`.
- **Renderers stay at arm's length**: chat bubbles and the inspector take
  their data through props and never import the store — the seam along
  which type-dispatched renderers (and, later, sandboxed third-party ones)
  slot in.
- **The didcomm WASM** is instantiated by `src/didcomm/wasm.ts` (the npm
  package's entry is webpack-shaped) and handed to the agent.

## Status

Early. Single public identity per install (pairwise DIDs per contact are
the next step), no offline outbox yet, no push notifications (a mediator
extension), keys in the browser under your passphrase. Storage is only
guaranteed once the browser grants persistence — install the app, and keep
a backup either way. Browsers: Chromium and Firefox, and Safari 26 or later
(the vault is written through OPFS `createWritable()`, which WebKit shipped
in Safari 26; older Safari gets a plain error at onboarding). Nothing here
has had an independent security audit.

## License

Apache-2.0

[@estoc/agent-core]: https://github.com/estoc-net/agent-core
[@estoc/keystore]: https://github.com/estoc-net/keystore
[didcomm-mediator]: https://github.com/estoc-net/didcomm-mediator
[vite-plugin-pwa]: https://vite-pwa-org.netlify.app/
