# estoc-net/estoc — workspace notes

pnpm workspace (`pnpm-workspace.yaml`): `packages/{did-peer,keystore,agent-core}` are
published libraries, `app/` is the PWA. Internal deps are `workspace:^` — never bump
a version or publish just to get a library change into the app; `pnpm build` at the
root builds in dependency order and the app resolves the symlinked `dist/`.

- Use `pnpm`, not `npm`. `pnpm deploy` is a builtin — deploying the app is `pnpm run deploy`
  at the root (wrangler.jsonc lives at the root; app/ has none). The Deploy button seeds
  the whole repo, so the button build must work from the root with pnpm.
- pnpm is strict about phantom deps: if a package imports it, it must be in that
  package's own `package.json` (this is how `bs58` in agent-core and `workbox-window`
  in app surfaced during the merge).
- Libraries export `dist/`; after editing a library run its `build` (or keep `pnpm dev`
  running at the root) before typechecking/testing the app against it.
- Publishing a library: bump `version` + `CHANGELOG.md`, `pnpm publish --access public`
  from the package dir; `prepublishOnly` runs test + build. npm 2FA needs a real TTY.
- One lockfile at the root. Don't add per-package lockfiles.
