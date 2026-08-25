# Changelog

## 0.4.0 — 2026-08-24

One package for the three layers. `@estoc/signed-dir` is retired: its
UnixFS tree (`hashTree`/`verifyTree`/`resolvePath`, golden vectors and
all) moves in here unchanged, and its half of the card joins the other
half, so the card has one home and one meaning.

- **Breaking:** the card is a JWS with `typ: estoc/object-card`; a card
  without it does not verify. Its payload is exactly `{did, root}`; any
  other member makes it malformed (a card is closed testimony — new
  meaning is a new `typ`, not a new field). `signRoot(did, root, signer)` /
  `verifyCard(jws)` replace signed-dir's `createCard`/`verifyCard` — the
  did:key rule (payload `did` is a did:key, `kid` its one method) is now
  the card's, not the caller's. `RootCard` is `ObjectCard`.
- **Breaking:** "bundle" is gone as a word and a verb. A *signed object*
  is `{object/, card.jws}`: `signedTree(object, card)` lays it out,
  `readAny(mapping)` recognizes a signed object or a bare one,
  `readSignedObject` insists on the card. Anything beside `object/` and
  `card.jws` is ignored, so a post directory with its rendered page *is*
  the signed object. `Bundle`, `bundleTree`, `readBundle`, `zipBundle`,
  `unzipMapping` are removed.
- The zip container is its own subpath, `@estoc/folder-object/zip`
  (`zipTree`/`unzipTree`), generic over mappings.
- `writeTree` (`/fs`) replaces the top-level entries it writes and leaves
  the rest of the directory alone.
- Depends on `ipfs-unixfs-importer`/`-exporter` and `multiformats`
  directly; no longer on `@estoc/signed-dir`.

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
