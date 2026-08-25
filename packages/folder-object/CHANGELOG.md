# Changelog

## 0.2.0 — 2026-08-24

- **Breaking:** `readTree`/`writeTree` moved to the `@estoc/folder-object/fs`
  subpath so the main entry pulls no `node:fs` and bundles for the browser
  (the app renders shared objects with it).

## 0.1.0 — 2026-08-24

- First release: read/validate/hash objects, did:key bundle cards, bundle dir/zip, post/1.0 djot renderer, `estoc-object` CLI.
