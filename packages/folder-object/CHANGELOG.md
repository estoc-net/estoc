# Changelog

## 0.6.0 — 2026-08-26

The closure as one file, for the package road (`estoc/docs/object-share.md`
§8).

- `encodeCar(roots, blocks)` / `decodeCar(bytes)`: CARv1 with a
  hand-encoded dag-cbor header — no CBOR dependency. Decoding checks
  every block against its CID and leaves out the ones that do not match
  (listed in `bad`), so every byte returned is named truthfully.
- `blobHash(bytes)` / `isBlobHash(name)`: the sha-256 multihash in
  base32 lower that names a blob (`estoc/docs/blob-store.md`).

## 0.5.0 — 2026-08-26

The tree's skeleton apart from its leaves, for sharing an object before
its bytes (`estoc/docs/object-share.md` §2, §7).

- `verifyTree(root, objects, { leaves: "optional" })`: every dag-pb
  block — directory nodes, HAMT shards, chunk indexes — is still
  required, but a raw block may be absent. The result gains `missing`
  (absent raw CID → the size its link claims) and `partial` (file path →
  its absent CIDs, for every file with one); both are empty under the default
  `leaves: "required"`, where an absent leaf throws as before. A present
  leaf is still hashed against its CID.
- `verifyTree` accepts a lookup function (`GetBlock`) as the object set,
  not only a map.
- The verify walk decodes dag-pb / UnixFS nodes itself instead of pulling
  leaves through `ipfs-unixfs-exporter`; `@ipld/dag-pb` and `ipfs-unixfs`
  become runtime dependencies. Roots and verdicts are unchanged (golden
  vectors, HAMT fixture).

## 0.4.0 — 2026-08-24

One package for the three layers. `@estoc/signed-dir` is retired: its
UnixFS tree (`hashTree`/`verifyTree`/`resolvePath`, golden vectors and
all) moves in here unchanged, and its half of the card joins the other
half, so the card has one home and one meaning.

- **Breaking:** hidden entries — any path segment beginning with `.` —
  are not part of an object's tree (`isHidden`), matching the
  `unixfs-v1-2025` profile's default so a folder hashes as `ipfs add -r`
  does; `readTree` skips them, and it now throws on a symbolic link (or
  any non-regular entry) instead of silently dropping it — a fact holds
  only files.
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
