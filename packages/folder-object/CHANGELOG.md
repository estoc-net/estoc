# Changelog

## 0.7.0 — Unreleased — the tree is DASL

The hash encoding is [DASL](https://dasl.ing/) (folder-object spec, `dasl`
branch, §2.1) instead of UnixFS, and nothing else: files as whole raw
blocks, the tree as one DRISL document in the shape of a MASL bundle
(`{resources: {"/path": {src, size}}}`), the root its drisl CID. Every
root changes (`bafyrei…` where it was `bafybei…`); a card over a UnixFS
root is malformed here; `ipfs add` no longer reproduces the root; every
block remains an IPLD block. There is no migration: nothing produced under
the UnixFS draft is read.

- Removed: the UnixFS tree (`ipfs-unixfs-importer` / `-exporter`,
  `@ipld/dag-pb`, `multiformats` — 4 MB of dependencies, 155 kB bundled —
  are gone; the package is 15 kB bundled), `HashOptions.dirs` (an empty
  directory is not a thing a tree holds), `HashedTree.nodes` (there are no
  nodes), `VerifiedTree.dirs`, `fileCid` / `isRawCid` / `isDagPbCid` /
  `compareNames` / `dagPbCode`, and `encodeCar` / `decodeCar` (now
  `@estoc/dasl`'s, over DASL CIDs only).
- The tree: `hashTree` returns `{root, manifest, entries, files}`;
  `verifyTree` / `walkTree` return `{root, files, sizes, missing, partial,
  declined}`; `resolvePath` is two fetches; `encodeManifest` /
  `decodeManifest` / `fetchManifest` / `walkLeaves` expose the manifest
  (closed shape; the decoded value must re-encode to the block's bytes;
  one `src` one `size`; at most `MAX_MANIFEST_BYTES`, 1 MiB); a manifest
  defect is a `ManifestError`.
- `verifyObject(root, blocks, options)`: the object read out of a root,
  judged a layer at a time — the manifest must be canonical and name
  exactly a canonical tree with `index.json` (format), decided before any
  leaf is asked for; then the leaves; then `index.json` well-formed
  (format) and `content.path` in the manifest (closure). With `leaves:
  "optional"` an absent leaf is a partial object, `index.json`'s own
  bytes included: `object` is then null, `tree` still says every path and
  size.
- A manifest is untrusted input. Laying out its paths is linear in their
  bytes whatever their depth (a trie of segments; a path of fifty thousand
  segments used to take seconds). `maxLeafBytes` is enforced on what
  arrives, not on what the manifest states: a block longer than the bound
  is declined unhashed (`declined` then holds its length), the block
  source is told the bound (`GetBlock`'s second argument, `limit`), and
  the manifest itself is never read past 1 MiB + 1.
- The card: `signRoot` and `verifyCard` refuse a `root` that is not the
  canonical spelling of a drisl DASL CID — this format defines no
  signature over bare bytes or over a UnixFS-era root; the payload is
  decoded as UTF-8 fatally (a byte that is not UTF-8 was replaced by
  U+FFFD and could pass the one-text check); the payload is the one text
  `{"did":…,"root":…}`, as before.
- `writeTree` places every path before it touches the directory: each
  segment must be one entry name on this platform (on Windows, `a\..` or
  `a\b` is not, though a mapping may hold it) and the result inside the
  directory given; `placeUnder` is exported for other projections.
- Golden vectors: the sea-day fixture roots at
  `bafyreicdsejj526l225wrfl5cpxcgehq4pzbpxphocvmiuvy6dpwi467aa`, its
  manifest pinned byte for byte, cross-checked against an independent
  Python encoder and `@ipld/dag-cbor` + `multiformats`.

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
