# Changelog

## 0.3.0 — 2026-08-24

- **Breaking:** the `estoc-object` CLI and the `post/1.0` renderer
  (`renderPost`, `fillTemplate`, `POST_FORMAT`) are gone. The package is
  the format only — read/validate/hash/sign/verify/bundle. The CLI lives
  on as `estoc object …` in `@estoc/cli`; the renderer moved into the app
  (`app/src/core/post.ts`), where projection belongs. `@djot/djot` is no
  longer a dependency.

## 0.2.0 — 2026-08-24

- **Breaking:** `readTree`/`writeTree` moved to the `@estoc/folder-object/fs`
  subpath so the main entry pulls no `node:fs` and bundles for the browser
  (the app renders shared objects with it).

## 0.1.0 — 2026-08-24

- First release: read/validate/hash objects, did:key bundle cards, bundle dir/zip, post/1.0 djot renderer, `estoc-object` CLI.
