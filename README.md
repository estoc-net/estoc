# estoc-net/estoc

The Estoc web app and the libraries it is made of, in one pnpm workspace:

| path | package | what |
|---|---|---|
| `app/` | `estoc-app` | the offline-first DIDComm v2 messenger you install as a web app — [app.estoc.dev](https://app.estoc.dev) |
| `packages/agent-core/` | [`@estoc/agent-core`](https://www.npmjs.com/package/@estoc/agent-core) | the agent: mediation, pickup, live delivery, pairwise DIDs, invitations, public folders, over an `.estoc` vault |
| `packages/keystore/` | [`@estoc/keystore`](https://www.npmjs.com/package/@estoc/keystore) | encrypted keystore — one sealed seed, HKDF-derived identities, non-extractable Signer handles |
| `packages/did-peer/` | [`@estoc/did-peer`](https://www.npmjs.com/package/@estoc/did-peer) | did:peer:2 / did:peer:4 codec + didcomm-rust DIDDoc conversion |
| `packages/signed-dir/` | `@estoc/signed-dir` | owner-signed directory trees — IPLD-notation merkle hashing + signed root card (not yet on npm) |

Inside the workspace every `@estoc/*` dependency is `workspace:^`: the app
builds against the libraries in this tree, so a change to `agent-core` is in
the app on the next build with no publish and no version bump in between.
The libraries are still published to npm for everyone else — `pnpm publish`
rewrites `workspace:^` to the real semver range on the way out — but that
now happens at milestones, not per commit.

The mediator ([didcomm-mediator]) stays its own repository: it is a thing
anyone runs, with its own one-click deploy, and depends only on the
published `@estoc/did-peer`.

## Work in it

```sh
pnpm install
pnpm build            # every package, in dependency order (libraries emit dist/)
pnpm test             # every package's vitest suite
pnpm typecheck
pnpm dev              # tsc --watch on the libraries + vite dev server for the app
```

Anything package-specific runs from that package's directory or via
`pnpm --filter <name> …`; each package's README has the details. The app's
e2e (`pnpm e2e`, after `pnpm build && pnpm --filter estoc-app preview`) is
documented in [`app/README.md`](app/README.md).

## Deploy the app

`wrangler.jsonc` sits at the workspace root and describes one Worker: the
app, as static assets from `app/dist`, built by `pnpm --filter 'estoc-app...'
run build`. `pnpm run deploy` here ships it (`run` because `pnpm deploy` is
a pnpm builtin). It is at the root rather than in `app/` because the
"Deploy to Cloudflare" button seeds a copy of the whole repository into the
deployer's account — that copy has the workspace, so the app is built from
the libraries beside it, not from npm.

## Publish a library

```sh
cd packages/agent-core
# bump version, update CHANGELOG.md
pnpm publish --access public     # prepublishOnly runs test + build first
```

If a published library's range no longer covers a workspace sibling (say
`agent-core` needs a `keystore` API that only exists at 0.3.0), bump the
sibling and publish it first — the `workspace:^` link means the app never
notices, but consumers on npm will.

## History

This repository was assembled on 2026-08-16 from four repositories —
[estoc-net/did-peer], [estoc-net/keystore], [estoc-net/agent-core],
[estoc-net/app] — with `git filter-repo --to-subdirectory-filter`, so each
package's full history is here under its current path (`git log --follow`
works across the move). The originals are archived.

[didcomm-mediator]: https://github.com/estoc-net/didcomm-mediator
[estoc-net/did-peer]: https://github.com/estoc-net/did-peer
[estoc-net/keystore]: https://github.com/estoc-net/keystore
[estoc-net/agent-core]: https://github.com/estoc-net/agent-core
[estoc-net/app]: https://github.com/estoc-net/app
